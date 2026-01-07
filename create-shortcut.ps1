$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath('Desktop')
$Shortcut = $WshShell.CreateShortcut("$DesktopPath\Auto-Claude.lnk")
$Shortcut.TargetPath = "C:\Users\jpswi\personal projects\Auto-Claude\Auto-Claude.bat"
$Shortcut.WorkingDirectory = "C:\Users\jpswi\personal projects\Auto-Claude"
$Shortcut.IconLocation = "C:\Users\jpswi\personal projects\Auto-Claude\apps\frontend\resources\icon.ico"
$Shortcut.Save()
Write-Host "Shortcut created on Desktop. Right-click it and select 'Pin to taskbar'"
