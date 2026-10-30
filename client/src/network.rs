use serde_json::{json, Value};
use std::{
    net::IpAddr,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub fn local_addresses() -> Vec<Value> {
    let networks = sysinfo::Networks::new_with_refreshed_list();
    let mut addresses = Vec::new();
    for (name, network) in &networks {
        for network in network.ip_networks() {
            let address = network.addr;
            if !address.is_loopback() && !address.is_unspecified() && !address.is_multicast() {
                addresses.push(json!({"interface": name, "address": address.to_string()}));
            }
        }
    }
    addresses.sort_by_key(|entry| format!("{}:{}", entry["interface"], entry["address"]));
    addresses.dedup();
    addresses.truncate(128);
    addresses
}

pub fn public_ip() -> Option<String> {
    static CACHE: OnceLock<Mutex<Option<(Instant, Option<IpAddr>)>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().ok()?;
    if let Some((checked, value)) = *cache {
        let ttl = if value.is_some() { 600 } else { 60 };
        if checked.elapsed() < Duration::from_secs(ttl) {
            return value.map(|ip| ip.to_string());
        }
    }
    let value = lookup_public_ip().ok();
    *cache = Some((Instant::now(), value));
    value.map(|ip| ip.to_string())
}

fn lookup_public_ip() -> anyhow::Result<IpAddr> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(4)))
        .max_redirects(0)
        .build()
        .new_agent();
    let text = agent
        .get("https://ipinfo.io/ip")
        .call()?
        .body_mut()
        .with_config()
        .limit(128)
        .read_to_string()?;
    Ok(text.trim().parse()?)
}
