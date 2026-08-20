Option Explicit

If WScript.Arguments.Named.Exists("check") Then WScript.Quit 0

' Desktop shortcut entry point. wscript.exe has no console window, so running the
' shortcut as administrator cannot leave an empty Windows Terminal tab behind.
Dim shell, fso, launcher, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

launcher = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "launcher.cmd")
If Not fso.FileExists(launcher) Then
  WScript.Quit 1
End If

' launcher.cmd keeps pause for direct/manual starts; hidden shortcut starts must exit
' after the result because there is no console for the user to interact with.
shell.Environment("Process")("WBSWITCH_NO_PAUSE") = "1"
command = """" & shell.ExpandEnvironmentStrings("%ComSpec%") & """ /d /c call """ & launcher & """"
shell.Run command, 0, False
