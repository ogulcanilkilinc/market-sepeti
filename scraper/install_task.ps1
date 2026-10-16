# Yunus fiyatlarini her sabah bu bilgisayardan GitHub'a gonderen zamanlanmis gorevi kurar.
# Calistirmak icin:  powershell -ExecutionPolicy Bypass -File scraper\install_task.ps1
# Kaldirmak icin:    Unregister-ScheduledTask -TaskName "Market Sepeti - Yunus" -Confirm:$false

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "push_yunus.py"
$repo = Split-Path $PSScriptRoot -Parent

# Pencere acilmasin diye pythonw.exe (python.exe'nin yanindaki) kullanilir.
$python = (& python -c "import sys; print(sys.executable)").Trim()
$pythonw = Join-Path (Split-Path $python -Parent) "pythonw.exe"
if (-not (Test-Path $pythonw)) { $pythonw = $python }

$action = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$script`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 07:00
# Bilgisayar 07:00'de kapaliysa, acildiginda calisir.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName "Market Sepeti - Yunus" -Action $action -Trigger $trigger -Settings $settings `
    -Description "Yunus Online fiyatlarini toplayip GitHub'daki market-sepeti reposuna gonderir." -Force | Out-Null
Write-Output "Kuruldu: her gun 07:00 ($pythonw $script)"
