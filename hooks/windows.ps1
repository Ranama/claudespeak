# claudespeak on Windows: the jobs curl, ffmpeg and pkill do on a Mac, done with Windows' own
# PowerShell and sound player, so nothing needs installing. hooks/register.ts starts it.
#
#   play  Claims the speech file, stops every other claudespeak voice on this computer, fetches the
#         clip from Fish as raw PCM and plays it. The Authorization value comes on standard input,
#         never on the command line, where any program could read it.
#   stop  Stops the voice with -Tag, or every claudespeak voice on this computer.
#   open  Opens -Path in Notepad.
param(
  [Parameter(Mandatory = $true)][ValidateSet('play', 'stop', 'open')][string]$Action,
  [string]$Tag = '',
  [string]$Body = '',
  [string]$Model = '',
  [string]$Url = '',
  [string]$Current = '',
  [int]$Rate = 44100,
  [string]$Path = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Every player is this script with -Action play and a -Tag claudespeak-<number>. -Only stops that one
# player; -Keep stops all but that one.
function Stop-Voices([string]$Only, [string]$Keep) {
  $mine = $PID
  $players = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object {
    $line = [string]$_.CommandLine
    $_.ProcessId -ne $mine -and $line -match 'windows\.ps1' -and $line -match '-Action\s+"?play\b' -and
      $line -match '-Tag\s+"?claudespeak-\d+' -and
      ($Only -eq '' -or $line -match ('-Tag\s+"?' + [regex]::Escape($Only) + '"?(\s|$)')) -and
      ($Keep -eq '' -or $line -notmatch ('-Tag\s+"?' + [regex]::Escape($Keep) + '"?(\s|$)'))
  }
  foreach ($player in $players) { Stop-Process -Id $player.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Read-Claim {
  if (-not (Test-Path -LiteralPath $Current)) { return '' }
  return ([string](Get-Content -LiteralPath $Current -Raw)).Trim()
}

# Fish's raw PCM is 16-bit mono at -Rate; Windows' player wants a WAV file, so it gets a header.
function Write-Wave([string]$Raw, [string]$Wave) {
  $data = [IO.File]::ReadAllBytes($Raw)
  $size = $data.Length - ($data.Length % 2)
  $out = New-Object IO.BinaryWriter ([IO.File]::Create($Wave))
  try {
    $ascii = [Text.Encoding]::ASCII
    $out.Write($ascii.GetBytes('RIFF')); $out.Write([int](36 + $size)); $out.Write($ascii.GetBytes('WAVE'))
    $out.Write($ascii.GetBytes('fmt ')); $out.Write([int]16); $out.Write([int16]1); $out.Write([int16]1)
    $out.Write([int]$Rate); $out.Write([int]($Rate * 2)); $out.Write([int16]2); $out.Write([int16]16)
    $out.Write($ascii.GetBytes('data')); $out.Write([int]$size); $out.Write($data, 0, $size)
  } finally {
    $out.Close()
  }
}

switch ($Action) {
  'open' {
    Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $Path + '"')
    exit 0
  }
  'stop' {
    Stop-Voices -Only $Tag -Keep ''
    exit 0
  }
  'play' {
    $auth = [Console]::In.ReadLine()
    $temp = [IO.Path]::GetTempPath()
    $raw = Join-Path $temp ($Tag + '.pcm')
    $wave = Join-Path $temp ($Tag + '.wav')
    $code = 0
    try {
      # What a stopped player left behind.
      Get-ChildItem -LiteralPath $temp -Filter 'claudespeak-*' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-10) } |
        Remove-Item -Force -ErrorAction SilentlyContinue

      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Current) | Out-Null
      [IO.File]::WriteAllText($Current, $Tag)
      Stop-Voices -Only '' -Keep $Tag
      if ((Read-Claim) -eq $Tag) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $fetched = $true
        try {
          Invoke-WebRequest -UseBasicParsing -Method Post -Uri $Url -Headers @{ Authorization = $auth; model = $Model } `
            -ContentType 'application/json' -InFile $Body -OutFile $raw -TimeoutSec 60
        } catch {
          $fetched = $false
          $status = 0
          $response = $_.Exception.Response
          if ($null -ne $response) { $status = [int]$response.StatusCode }
          [Console]::Error.WriteLine("returned error: $status")
          $code = 22
        }
        # A newer voice, or /speak stop, may have claimed the speech while this one was fetching.
        if ($fetched -and (Read-Claim) -eq $Tag) {
          Write-Wave $raw $wave
          (New-Object System.Media.SoundPlayer $wave).PlaySync()
        }
      }
    } catch {
      [Console]::Error.WriteLine('playback: ' + ($_.Exception.Message -replace '\s+', ' '))
      $code = 1
    } finally {
      foreach ($file in @($Body, $raw, $wave)) {
        if ($file -ne '') { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
      }
    }
    exit $code
  }
}
