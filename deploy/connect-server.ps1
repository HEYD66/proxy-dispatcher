param(
    [Parameter(Mandatory = $true)][string]$Server,
    [int]$SshPort = 22,
    [string]$SshUser = 'root',
    [int]$LocalPort = 17473,
    [int]$ManagementPort = 4173
)

$ErrorActionPreference = 'Stop'
if (Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue) {
    throw "本机 $LocalPort 端口已经被占用，请检查已有隧道或换一个 LocalPort。"
}
$sshPath = (Get-Command ssh.exe -ErrorAction Stop).Source
Write-Host "连接成功后打开 http://127.0.0.1:$LocalPort/ 。密码由 SSH 交互输入，本脚本不保存密码。"
Write-Host '保持此终端运行。按 Ctrl+C 仅关闭本机隧道，服务器服务继续运行。'
& $sshPath -N -T -p $SshPort -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L "127.0.0.1:${LocalPort}:127.0.0.1:${ManagementPort}" "${SshUser}@${Server}"
exit $LASTEXITCODE
