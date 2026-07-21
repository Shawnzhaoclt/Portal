Option Explicit

Dim shell, fileSystem, scriptDirectory, pythonScript, configPath
Dim configuredPython, condaCandidates, environments, candidate, environmentName
Dim condaCommand, command

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
pythonScript = fileSystem.BuildPath(scriptDirectory, "sync_portal_sources.py")
configPath = fileSystem.BuildPath(scriptDirectory, "sync.settings.json")

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function

Function EnvironmentValue(name)
    Dim marker, value
    marker = "%" & name & "%"
    value = shell.ExpandEnvironmentStrings(marker)
    If value = marker Then value = ""
    EnvironmentValue = value
End Function

Function CommandWorks(value)
    CommandWorks = (shell.Run("cmd.exe /d /c " & value & " >nul 2>&1", 0, True) = 0)
End Function

Function ConfigTextValue(name, fallbackValue)
    Dim stream, content, expression, matches
    ConfigTextValue = fallbackValue
    If Not fileSystem.FileExists(configPath) Then Exit Function
    Set stream = fileSystem.OpenTextFile(configPath, 1, False, 0)
    content = stream.ReadAll
    stream.Close
    Set expression = New RegExp
    expression.Pattern = """" & name & """\s*:\s*""([^""]+)"""
    expression.IgnoreCase = True
    Set matches = expression.Execute(content)
    If matches.Count > 0 Then ConfigTextValue = matches(0).SubMatches(0)
End Function

Function ClockMinutes(value)
    Dim parts
    parts = Split(value, ":")
    ClockMinutes = CInt(parts(0)) * 60 + CInt(parts(1))
End Function

Function StartWindowIsOpen()
    Dim currentMinutes, allowedMinutes, lastMinutes
    currentMinutes = Hour(Now) * 60 + Minute(Now)
    allowedMinutes = ClockMinutes(ConfigTextValue("allowedStartTime", "07:00"))
    lastMinutes = ClockMinutes(ConfigTextValue("lastRunTime", "16:30"))
    StartWindowIsOpen = currentMinutes >= allowedMinutes And currentMinutes <= lastMinutes
End Function

Function SchedulerIsRunning()
    Dim processService, processes, process, processCommand
    SchedulerIsRunning = False
    Set processService = GetObject("winmgmts:\\.\root\cimv2")
    Set processes = processService.ExecQuery( _
        "SELECT CommandLine FROM Win32_Process " _
        & "WHERE Name = 'python.exe' OR Name = 'pythonw.exe'" _
    )
    For Each process In processes
        If Not IsNull(process.CommandLine) Then
            processCommand = LCase(CStr(process.CommandLine))
            If InStr(processCommand, "sync_portal_sources.py") > 0 _
                And InStr(processCommand, "--schedule") > 0 Then
                SchedulerIsRunning = True
                Exit Function
            End If
        End If
    Next
End Function

Sub StartWithPython(pythonExecutable)
    command = Quote(pythonExecutable) & " " & Quote(pythonScript) _
        & " --config " & Quote(configPath) & " --schedule --non-interactive"
    shell.Run command, 0, False
    WScript.Quit 0
End Sub

Sub StartWithConda(condaExecutable, condaEnvironment)
    Dim prefix
    If LCase(condaExecutable) = "conda" Then
        prefix = "call conda"
    Else
        prefix = "call " & Quote(condaExecutable)
    End If
    command = "cmd.exe /d /c " & prefix & " run --no-capture-output -n " _
        & condaEnvironment & " python " & Quote(pythonScript) _
        & " --config " & Quote(configPath) & " --schedule --non-interactive"
    shell.Run command, 0, False
    WScript.Quit 0
End Sub

If SchedulerIsRunning() Then
    MsgBox "Portal data sync is already running. A second process was not started.", _
        vbInformation, "Portal Data Sync"
    WScript.Quit 0
End If

If Not StartWindowIsOpen() Then
    MsgBox "Portal data sync can only be started from " _
        & ConfigTextValue("allowedStartTime", "07:00") & " through " _
        & ConfigTextValue("lastRunTime", "16:30") & ".", _
        vbInformation, "Portal Data Sync"
    WScript.Quit 0
End If

configuredPython = EnvironmentValue("PORTAL_SYNC_PYTHON")
If configuredPython <> "" Then
    If CommandWorks(Quote(configuredPython) & " -c " _
        & Quote("import pyodbc")) Then
        StartWithPython configuredPython
    End If
End If

condaCandidates = Array( _
    fileSystem.BuildPath(EnvironmentValue("LOCALAPPDATA"), "miniconda3\condabin\conda.bat"), _
    fileSystem.BuildPath(EnvironmentValue("USERPROFILE"), "miniconda3\condabin\conda.bat"), _
    "conda" _
)
environments = Array("portal", "geo_remote", "base")

For Each candidate In condaCandidates
    If LCase(candidate) = "conda" Or fileSystem.FileExists(candidate) Then
        If LCase(candidate) = "conda" Then
            condaCommand = "call conda"
        Else
            condaCommand = "call " & Quote(candidate)
        End If

        For Each environmentName In environments
            command = condaCommand & " run -n " & environmentName & " python -c " _
                & Quote("import pyodbc")
            If CommandWorks(command) Then
                StartWithConda candidate, environmentName
            End If
        Next
    End If
Next

MsgBox "Python with pyodbc was not found. " _
    & "Install pyodbc in the portal Conda environment or set PORTAL_SYNC_PYTHON.", _
    vbCritical, "Portal Data Sync"
WScript.Quit 1
