Option Explicit

Dim shell, fileSystem, scriptDirectory, monitorPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
monitorPath = fileSystem.BuildPath(scriptDirectory, "sync_monitor.ps1")
command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass " _
    & "-WindowStyle Hidden -File """ & monitorPath & """"

shell.Run command, 0, False
