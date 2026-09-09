' Launches the Video Editor app hidden (no console window).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\gupol\Documents\Video_Editor_App"
sh.Run "cmd /c npm run start", 0, False
