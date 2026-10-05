@echo off
REM Thin wrapper so the same local check runs on Windows: `check.cmd`
pushd "%~dp0"
node tools\check.mjs %*
set code=%ERRORLEVEL%
popd
exit /b %code%
