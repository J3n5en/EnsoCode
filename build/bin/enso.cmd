@echo off
setlocal
set "target=%~1"
if not defined target set "target=."
if not exist "%target%\*" (
  echo enso: "%target%" is not a folder 1>&2
  exit /b 1
)
for %%I in ("%target%\.") do set "target=%%~fI"
start "" "%~dp0..\..\EnsoCode.exe" "--open-folder=%target%"
