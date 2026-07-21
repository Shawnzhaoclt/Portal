Option Explicit

Dim processService, processes, process, commandLine, result, stoppedCount, failedCount

Set processService = GetObject("winmgmts:\\.\root\cimv2")
Set processes = processService.ExecQuery( _
    "SELECT ProcessId, Name, CommandLine FROM Win32_Process " _
    & "WHERE Name = 'python.exe' OR Name = 'pythonw.exe'" _
)

stoppedCount = 0
failedCount = 0

For Each process In processes
    If Not IsNull(process.CommandLine) Then
        commandLine = LCase(CStr(process.CommandLine))
        If InStr(commandLine, "sync_portal_sources.py") > 0 _
            And InStr(commandLine, "--schedule") > 0 Then
            result = process.Terminate()
            If result = 0 Then
                stoppedCount = stoppedCount + 1
            Else
                failedCount = failedCount + 1
            End If
        End If
    End If
Next

If stoppedCount > 0 And failedCount = 0 Then
    MsgBox "Portal data sync stopped.", vbInformation, "Portal Data Sync"
ElseIf stoppedCount > 0 Then
    MsgBox "Portal data sync stopped, but one matching process could not be terminated.", _
        vbExclamation, "Portal Data Sync"
ElseIf failedCount > 0 Then
    MsgBox "The Portal data sync process could not be terminated.", _
        vbCritical, "Portal Data Sync"
Else
    MsgBox "Portal data sync is not running.", vbInformation, "Portal Data Sync"
End If
