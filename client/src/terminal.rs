//! Connection-scoped PTYs. Dedicated I/O threads never occupy Tokio's small
//! blocking pool. One acknowledged output chunk per session bounds memory.
use anyhow::{bail, Context as _, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc},
    thread,
    time::{Duration, Instant},
};
use tokio::sync::mpsc::Sender;

const TICK: Duration = Duration::from_millis(100);
const MAX_SESSIONS: usize = 2;

enum Control { Input(Vec<u8>), Resize(PtySize) }
struct Session {
    stop: Arc<AtomicBool>,
    control: mpsc::SyncSender<Control>,
    ack: mpsc::SyncSender<u64>,
    worker: thread::JoinHandle<()>,
}
impl Drop for Session {
    fn drop(&mut self) { self.stop.store(true, Ordering::Release); }
}

pub struct Terminals {
    sessions: HashMap<String, Session>,
    output: Sender<Value>,
    context: Arc<crate::operations::Context>,
}
impl Terminals {
    pub fn new(output: Sender<Value>, context: Arc<crate::operations::Context>) -> Self {
        Self { sessions: HashMap::new(), output, context }
    }
    pub fn clear(&mut self) {
        for session in self.sessions.values() { session.stop.store(true, Ordering::Release); }
        // main can exit immediately after its async runtime stops. Give the
        // dedicated workers time to reap their shells before process shutdown.
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.sessions.values().any(|s| !s.worker.is_finished()) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        self.sessions.clear();
    }
    pub fn finished(&mut self, id: &str) {
        // Keep closing workers counted until they finish: rapid open/close
        // requests must not bypass the per-device thread/session limit.
        if let Some(session) = self.sessions.get(id) {
            session.stop.store(true, Ordering::Release);
        }
    }
    pub fn handle(&mut self, value: &Value) -> Result<()> {
        self.sessions.retain(|_, s| !s.worker.is_finished());
        let id = value["session"].as_str().context("Missing terminal session")?;
        uuid::Uuid::parse_str(id).context("Invalid terminal session")?;
        let event = value["event"].as_str().context("Missing terminal event")?;
        if event == "close" { self.finished(id); return Ok(()); }
        if self.context.disable_shell { bail!("Shell execution is disabled on this device"); }
        if event == "open" {
            if self.sessions.contains_key(id) { bail!("Terminal session already exists"); }
            if self.sessions.len() >= MAX_SESSIONS { bail!("Too many terminal sessions"); }
            let size = dimensions(value)?;
            let stop = Arc::new(AtomicBool::new(false));
            let (control, commands) = mpsc::sync_channel(32);
            let (ack, acknowledgements) = mpsc::sync_channel(1);
            let worker_stop = stop.clone();
            let output = self.output.clone();
            let context = self.context.clone();
            let session_id = id.to_owned();
            let worker = thread::Builder::new().name("terminal-session".into()).spawn(move || {
                // portable-pty may panic on systems without ConPTY. Keep failure
                // local to this terminal instead of killing the agent connection.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_session(&session_id, size, context, commands, acknowledgements, worker_stop, &output)
                }));
                let error = match result {
                    Ok(Ok(())) => return,
                    Ok(Err(error)) => error.to_string(),
                    Err(_) => "Terminal initialization failed; Windows 10 1809 / Server 2019 or newer is required".into(),
                };
                let _ = output.blocking_send(json!({"type":"terminal", "session":session_id, "event":"error", "detail":error}));
            })?;
            self.sessions.insert(id.into(), Session { stop, control, ack, worker });
            return Ok(());
        }
        let session = self.sessions.get(id).context("Terminal session is closed")?;
        let result = match event {
            "input" => {
                let data = value["data"].as_str().context("Invalid terminal input")?;
                if data.is_empty() || data.len() > 4096 { bail!("Terminal input exceeds limit"); }
                session.control.try_send(Control::Input(data.as_bytes().to_vec())).map_err(anyhow::Error::from)
            }
            "resize" => session.control.try_send(Control::Resize(dimensions(value)?)).map_err(anyhow::Error::from),
            "ack" => session.ack.try_send(value["sequence"].as_u64().context("Invalid terminal acknowledgement")?).map_err(anyhow::Error::from),
            _ => bail!("Unsupported terminal event"),
        };
        if result.is_err() { session.stop.store(true, Ordering::Release); }
        result.context("Terminal input queue is full or closed")
    }
}

impl Drop for Terminals {
    fn drop(&mut self) { self.clear(); }
}

fn dimensions(value: &Value) -> Result<PtySize> {
    let cols = value["cols"].as_u64().filter(|x| (2..=500).contains(x)).context("Invalid terminal columns")?;
    let rows = value["rows"].as_u64().filter(|x| (1..=300).contains(x)).context("Invalid terminal rows")?;
    Ok(PtySize { cols: cols as u16, rows: rows as u16, pixel_width: 0, pixel_height: 0 })
}

struct Process {
    child: Box<dyn Child + Send + Sync>,
    #[cfg(unix)]
    terminal_fd: Option<std::os::fd::RawFd>,
    #[cfg(windows)]
    job: Option<Job>,
}
impl Process {
    fn stop(&mut self) {
        #[cfg(unix)]
        if let Some(fd) = self.terminal_fd.take() {
            // Interactive shells give foreground jobs their own process group.
            // Stop that job as well as the shell's group on disconnect.
            unsafe {
                let foreground = libc::tcgetpgrp(fd);
                if foreground > 1 && foreground != libc::getpgrp() { libc::kill(-foreground, libc::SIGKILL); }
                if let Some(pid) = self.child.process_id() {
                    if pid > 1 && pid as i32 != libc::getpgrp() { libc::kill(-(pid as i32), libc::SIGKILL); }
                }
            }
        }
        #[cfg(windows)]
        { self.job.take(); }
        let _ = self.child.kill();
    }
}
impl Drop for Process {
    fn drop(&mut self) { self.stop(); let _ = self.child.wait(); }
}

#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Job {
    fn attach(child: &dyn Child) -> Result<Self> {
        use windows_sys::Win32::{Foundation::*, System::JobObjects::*};
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() { return Err(std::io::Error::last_os_error().into()); }
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits as *const _ as _, std::mem::size_of_val(&limits) as u32) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle().context("Missing shell process handle")? as HANDLE) == 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(job)
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); } }
}

fn run_session(
    id: &str, size: PtySize, context: Arc<crate::operations::Context>, commands: mpsc::Receiver<Control>,
    acknowledgements: mpsc::Receiver<u64>, stop: Arc<AtomicBool>, output: &Sender<Value>,
) -> Result<()> {
    if stop.load(Ordering::Acquire) { return Ok(()); }
    let pair = native_pty_system().openpty(size)?;
    #[cfg(windows)]
    let mut cmd = {
        // ConPTY's supported interactive setup starts cmd.exe without command
        // line switches. Passing /D here makes cmd report a syntax error on
        // some Windows installations before the first prompt is shown.
        let system = std::env::var_os("SystemRoot").context("SystemRoot is not set")?;
        CommandBuilder::new(std::path::PathBuf::from(system).join("System32/cmd.exe"))
    };
    #[cfg(unix)]
    let mut cmd = {
        let shell = std::env::var_os("SHELL").filter(|p| std::path::Path::new(p).is_absolute() && std::path::Path::new(p).is_file())
            .unwrap_or_else(|| if std::path::Path::new("/bin/bash").exists() { "/bin/bash".into() } else { "/bin/sh".into() });
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-i");
        cmd
    };
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(context.root.clone().unwrap_or(std::env::current_dir()?));
    let reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    #[cfg(unix)]
    let poll_fd = {
        use std::os::fd::FromRawFd;
        let fd = unsafe { libc::dup(pair.master.as_raw_fd().context("Missing PTY descriptor")?) };
        if fd < 0 { return Err(std::io::Error::last_os_error().into()); }
        unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) }
    };
    let mut process = Process {
        child: pair.slave.spawn_command(cmd)?,
        #[cfg(unix)]
        terminal_fd: pair.master.as_raw_fd(),
        #[cfg(windows)]
        job: None,
    };
    #[cfg(windows)]
    { process.job = Some(Job::attach(process.child.as_ref())?); }
    drop(pair.slave);
    let id_owned = id.to_owned();
    let read_stop = stop.clone();
    let read_output = output.clone();
    let producer_done = Arc::new(AtomicBool::new(false));
    let read_done = producer_done.clone();
    output.blocking_send(json!({"type":"terminal", "session":id, "event":"ready"}))?;
    let reader_thread = thread::Builder::new().name("terminal-output".into()).spawn(move || {
        let result = read_output_loop(reader, acknowledgements, &read_stop, &read_done, &read_output, &id_owned,
            #[cfg(unix)] poll_fd);
        if result.is_err() { read_stop.store(true, Ordering::Release); }
        result
    })?;
    let (input, inputs) = mpsc::sync_channel::<Vec<u8>>(16);
    let write_stop = stop.clone();
    let writer_thread = thread::Builder::new().name("terminal-input".into()).spawn(move || {
        while !write_stop.load(Ordering::Acquire) {
            match inputs.recv_timeout(TICK) {
                Ok(data) => if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                    write_stop.store(true, Ordering::Release); break;
                },
                Err(mpsc::RecvTimeoutError::Timeout) => {},
                Err(_) => break,
            }
        }
    });
    let result = (|| -> Result<Option<u32>> {
        if writer_thread.is_err() { bail!("Cannot start terminal input worker"); }
        loop {
            if stop.load(Ordering::Acquire) { return Ok(None); }
            if let Some(status) = process.child.try_wait()? { return Ok(Some(status.exit_code())); }
            match commands.recv_timeout(TICK) {
                Ok(Control::Input(data)) => input.try_send(data).context("Terminal input is too fast")?,
                Ok(Control::Resize(size)) => pair.master.resize(size)?,
                Err(mpsc::RecvTimeoutError::Timeout) => {},
                Err(_) => return Ok(None),
            }
        }
    })();
    if result.is_err() { stop.store(true, Ordering::Release); }
    process.stop();
    let _ = process.child.wait();
    producer_done.store(true, Ordering::Release);
    drop(input);
    // ConPTY close needs a live reader to drain its final output.
    drop(pair.master);
    if let Ok(worker) = writer_thread { let _ = worker.join(); }
    let read_result = reader_thread.join().map_err(|_| anyhow::anyhow!("Terminal output worker failed"))?;
    read_result?;
    let code = result?;
    output.blocking_send(json!({"type":"terminal", "session":id, "event":"exit", "exit_code":code}))?;
    Ok(())
}

fn read_output_loop(
    mut reader: Box<dyn Read + Send>, ack: mpsc::Receiver<u64>, stop: &AtomicBool, done: &AtomicBool,
    output: &Sender<Value>, id: &str, #[cfg(unix)] fd: std::os::fd::OwnedFd,
) -> Result<()> {
    let mut buffer = [0u8; 16384];
    let mut sequence = 0u64;
    loop {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if stop.load(Ordering::Acquire) { return Ok(()); }
            let mut poll = libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            let ready = unsafe { libc::poll(&mut poll, 1, 100) };
            if ready < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted { continue; }
                return Err(error.into());
            }
            if ready == 0 {
                if done.load(Ordering::Acquire) { return Ok(()); }
                continue;
            }
        }
        #[cfg(windows)]
        let _ = done;
        let count = match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            #[cfg(unix)]
            Err(e) if e.raw_os_error() == Some(libc::EIO) => return Ok(()),
            Err(e) if stop.load(Ordering::Acquire) || e.kind() == std::io::ErrorKind::BrokenPipe => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        // On Windows continue draining after cancellation so ClosePseudoConsole
        // cannot deadlock waiting for a full output pipe.
        if stop.load(Ordering::Acquire) { continue; }
        sequence += 1;
        if output.blocking_send(json!({"type":"terminal", "session":id, "event":"output", "sequence":sequence, "data":STANDARD.encode(&buffer[..count])})).is_err() {
            stop.store(true, Ordering::Release); continue;
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if stop.load(Ordering::Acquire) { break; }
            match ack.recv_timeout(TICK) {
                Ok(value) if value == sequence => break,
                Ok(_) => bail!("Invalid terminal output acknowledgement"),
                Err(mpsc::RecvTimeoutError::Disconnected) => { stop.store(true, Ordering::Release); break; },
                Err(_) if Instant::now() >= deadline => bail!("Terminal output acknowledgement timed out"),
                Err(_) => {},
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::{sync::mpsc as async_mpsc, time::timeout};

    fn setup(disabled: bool) -> (Terminals, async_mpsc::Receiver<Value>, String) {
        let (tx, rx) = async_mpsc::channel(16);
        let context = Arc::new(crate::operations::Context { root: None, disable_shell: disabled });
        (Terminals::new(tx, context), rx, uuid::Uuid::new_v4().to_string())
    }
    fn input(terminals: &mut Terminals, id: &str, data: &str) {
        terminals.handle(&json!({"session":id, "event":"input", "data":data})).unwrap();
    }
    async fn next(rx: &mut async_mpsc::Receiver<Value>) -> Value {
        timeout(Duration::from_secs(8), rx.recv()).await.expect("PTY response timed out").unwrap()
    }
    async fn until(terminals: &mut Terminals, rx: &mut async_mpsc::Receiver<Value>, id: &str, marker: &str) -> String {
        let mut data = Vec::new();
        loop {
            let event = next(rx).await;
            assert_eq!(event["event"], "output", "{event}");
            data.extend(STANDARD.decode(event["data"].as_str().unwrap()).unwrap());
            terminals.handle(&json!({"session":id,"event":"ack","sequence":event["sequence"]})).unwrap();
            let output = String::from_utf8_lossy(&data);
            if output.contains(marker) { return output.into_owned(); }
        }
    }
    #[tokio::test]
    async fn preserves_shell_state_resize_interrupt_and_final_output() {
        let (mut terminals, mut rx, id) = setup(false);
        terminals.handle(&json!({"session":id,"event":"open","cols":80,"rows":24})).unwrap();
        assert_eq!(next(&mut rx).await["event"], "ready");
        input(&mut terminals, &id, "stty -echo; printf '\\n\\120TY_READY\\n'\n");
        until(&mut terminals, &mut rx, &id, "\r\nPTY_READY\r\n").await;
        input(&mut terminals, &id, "cd /tmp; export REMOTE_PTY_TEST=continuous\n");
        input(&mut terminals, &id, "printf '\\n%s:%s\\n' \"$PWD\" \"$REMOTE_PTY_TEST\"\n");
        until(&mut terminals, &mut rx, &id, "/tmp:continuous").await;
        terminals.handle(&json!({"session":id,"event":"resize","cols":101,"rows":42})).unwrap();
        input(&mut terminals, &id, "stty size\n");
        until(&mut terminals, &mut rx, &id, "42 101").await;
        input(&mut terminals, &id, "sleep 60\n");
        tokio::time::sleep(Duration::from_millis(200)).await;
        input(&mut terminals, &id, "\x03");
        input(&mut terminals, &id, "printf '\\nINTERRUPTED\\n'\n");
        until(&mut terminals, &mut rx, &id, "INTERRUPTED").await;
        input(&mut terminals, &id, "printf '\\nFINAL_OUTPUT\\n'; exit 7\n");
        until(&mut terminals, &mut rx, &id, "FINAL_OUTPUT").await;
        loop {
            let event = next(&mut rx).await;
            if event["event"] == "output" {
                terminals.handle(&json!({"session":id,"event":"ack","sequence":event["sequence"]})).unwrap();
            } else {
                assert_eq!(event["event"], "exit", "{event}");
                assert_eq!(event["exit_code"], 7);
                break;
            }
        }
    }
    #[tokio::test]
    async fn cancellation_unblocks_output_backpressure_and_reaps_shell() {
        let (mut terminals, mut rx, id) = setup(false);
        terminals.handle(&json!({"session":id,"event":"open","cols":80,"rows":24})).unwrap();
        assert_eq!(next(&mut rx).await["event"], "ready");
        input(&mut terminals, &id, "stty -echo; printf '\\n\\120ID=%s\\n' $$\n");
        let output = until(&mut terminals, &mut rx, &id, "\r\nPID=").await;
        let pid: i32 = output.split("\r\nPID=").nth(1).unwrap().lines().next().unwrap().trim().parse().unwrap();
        input(&mut terminals, &id, "yes\n");
        assert_eq!(next(&mut rx).await["event"], "output");
        // No acknowledgement: another chunk must not arrive.
        assert!(timeout(Duration::from_millis(200), rx.recv()).await.is_err());
        drop(terminals);
        timeout(Duration::from_secs(5), async {
            while unsafe { libc::kill(pid, 0) } == 0 { tokio::time::sleep(TICK).await; }
        }).await.expect("Shell leaked after disconnect");
    }
    #[test]
    fn validates_disabled_shell_and_terminal_dimensions() {
        let (mut terminals, _rx, id) = setup(true);
        assert!(terminals.handle(&json!({"session":id,"event":"open","cols":80,"rows":24})).unwrap_err().to_string().contains("disabled"));
        for value in [json!({"cols":0,"rows":24}), json!({"cols":80,"rows":true}), json!({"cols":501,"rows":24})] {
            assert!(dimensions(&value).is_err());
        }
    }
}
