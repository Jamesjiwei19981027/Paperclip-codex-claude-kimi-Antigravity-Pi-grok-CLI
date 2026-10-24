function Get-SetupCompanyId {
  $value = $env:PAPERCLIP_COMPANY_ID
  $parsed = [guid]::Empty
  if ([string]::IsNullOrWhiteSpace($value) -or
      ![guid]::TryParse($value, [ref]$parsed) -or $parsed -eq [guid]::Empty) {
    throw 'Set PAPERCLIP_COMPANY_ID to the UUID of the target company before running a creation script.'
  }
  return $parsed.ToString()
}

function Resolve-SetupGitBash {
  param([string]$ExplicitPath)
  if (![string]::IsNullOrWhiteSpace($ExplicitPath)) {
    $candidate = [IO.Path]::GetFullPath($ExplicitPath)
    if (!(Test-Path -LiteralPath $candidate -PathType Leaf) -or
        [IO.Path]::GetFileName($candidate) -ne 'bash.exe' -or
        $candidate -match '[\\/]Windows[\\/](System32|Sysnative)[\\/]') {
      throw 'The configured shell must point to Git Bash bash.exe, not the WSL launcher.'
    }
    return $candidate
  }

  $gitCommands = @(Get-Command git.exe -CommandType Application -All -ErrorAction SilentlyContinue)
  foreach ($gitCommand in $gitCommands) {
    $directory = Split-Path $gitCommand.Source -Parent
    for ($depth = 0; $depth -lt 4 -and $directory; $depth++) {
      foreach ($relative in @('bin\bash.exe', 'usr\bin\bash.exe')) {
        $candidate = Join-Path $directory $relative
        $gitMarker = Join-Path $directory 'cmd\git.exe'
        $portableMarker = Join-Path $directory 'mingw64\bin\git.exe'
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and
            ((Test-Path -LiteralPath $gitMarker -PathType Leaf) -or
             (Test-Path -LiteralPath $portableMarker -PathType Leaf))) {
          return [IO.Path]::GetFullPath($candidate)
        }
      }
      $directory = Split-Path $directory -Parent
    }
  }
  throw 'Git Bash was not found. Install Git for Windows or set the explicit shell path.'
}
