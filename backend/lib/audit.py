ACTION_LABELS = {
    'terminal.session': '交互式终端会话',
    'client.config': '保存被控端配置', 'client.build': '编译被控端', 'client.download': '下载被控端',
    'agent.update': '升级被控端程序', 'client.publish': '发布被控端升级版本',
    'client.delete': '删除被控端编译记录', 'agent.reinstall': '重新下发被控端程序',
    'login': '登录控制台', 'logout': '退出登录', 'system.info': '读取系统信息',
    'system.environment': '读取环境变量',
    'screen.capture': '获取屏幕截图', 'fs.list': '浏览目录', 'fs.mkdir': '创建目录',
    'fs.delete': '删除文件或目录', 'fs.rename': '重命名', 'fs.text': '读取文本',
    'fs.edit': '保存文本', 'fs.read': '下载文件', 'fs.write': '上传文件',
    'process.list': '查看进程', 'ports.list': '查看端口', 'shell.exec': '执行终端命令',
    'process.kill': '结束进程', 'screen.input': '屏幕鼠标键盘操作', 'screen.observe': '观察屏幕',
}


def operation_target(action, params):
    if action == 'process.kill':
        return f"PID {params.get('pid', '')}"
    if action == 'screen.input':
        return {'click': '鼠标点击', 'scroll': '鼠标滚轮', 'key': '键盘按键', 'text': '文本输入'}.get(params.get('kind'), '桌面输入')
    if action == 'fs.rename':
        return f"{params.get('path', '')} → {params.get('destination', '')}"
    if action.startswith('fs.'):
        return params.get('path', '')
    return {'shell.exec': '终端命令（不保存命令正文）', 'screen.capture': '主屏幕',
            'system.info': '系统信息', 'system.environment': '环境变量',
            'process.list': '进程列表', 'ports.list': '端口列表'}.get(action, '')


def operation_result(action, result):
    result = result if isinstance(result, dict) else {}
    if action in {'shell.exec', 'ports.list'}:
        code = result.get('exit_code')
        status = 'success' if code == 0 else 'failed'
        detail = f"执行结束，退出码 {code}。" if code is not None else '进程结束，未返回正常退出码。'
        if result.get('truncated'):
            detail += ' 输出超过上限，已截断。'
        return status, detail
    if action == 'fs.list':
        entries = result.get('entries', [])
        return 'success', f"已读取 {len(entries) if isinstance(entries, list) else 0} 个目录项。"
    return 'success', {
        'system.info': '已读取设备系统信息。', 'screen.capture': '已获取屏幕截图。',
        'fs.mkdir': '目录已创建。', 'fs.delete': '文件或目录已删除。', 'fs.rename': '已完成重命名。',
        'fs.text': '文本已读取。', 'fs.edit': '文本已保存。', 'fs.read': '文件已读取，可供下载。',
        'fs.write': '文件已上传并写入设备。', 'process.list': '已读取进程列表。',
        'process.kill': '已向进程发送结束信号。', 'system.environment': '已读取环境变量。',
        'screen.input': '已发送桌面输入。',
    }.get(action, '设备已返回成功响应。')


def describe_record(row):
    row = dict(row)
    row['action_label'] = ACTION_LABELS.get(row['action'], row['action'])
    if not row['detail']:
        row['detail'] = {
            'success': '操作成功；历史记录未保存更多说明。',
            'started': '请求已发出，等待设备响应。',
            'failed': '操作失败；历史记录未保存原因。',
            'denied': '身份验证未通过。',
            'timeout': '等待响应超时，操作可能已经执行，请核实设备状态。',
            'interrupted': '主控已重启，无法确认这次操作的最终结果。',
        }.get(row['status'], '没有补充说明。')
    return row
