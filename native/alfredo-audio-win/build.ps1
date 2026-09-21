# Builds the system-audio recorder into %USERPROFILE%\.alfredo\bin.
# Needs the MSVC build tools (Visual Studio, or the standalone Build Tools);
# run this from a "Developer PowerShell for VS" so cl.exe is on PATH.
$ErrorActionPreference = 'Stop'
$home_dir = if ($env:ALFREDO_HOME) { $env:ALFREDO_HOME } else { Join-Path $env:USERPROFILE '.alfredo' }
$bin = Join-Path $home_dir 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Push-Location $PSScriptRoot
try {
  & cl /nologo /O2 /EHsc /std:c++17 main.cpp /Fe:"$bin\alfredo-audio.exe" /link ole32.lib
  if ($LASTEXITCODE -ne 0) { throw "compile failed" }
  Remove-Item -Force main.obj -ErrorAction SilentlyContinue
  Write-Host "installed $bin\alfredo-audio.exe"
} finally { Pop-Location }
