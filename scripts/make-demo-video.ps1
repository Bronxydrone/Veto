# Rebuild docs/shots/veto-demo.mp4 from the committed screenshots.
#
# Needs: Python with Pillow (already used by scripts/render_terminal.py) and ffmpeg.
# ffmpeg is NOT a project dependency - point FFMPEG at a binary you already have:
#
#   $env:FFMPEG = "C:\tools\ffmpeg\bin\ffmpeg.exe"
#   pwsh -ExecutionPolicy Bypass -File .\scripts\make-demo-video.ps1
#
# Without FFMPEG the script looks for `ffmpeg` on PATH and stops with a clear message.
param(
    [string]$Ffmpeg = $env:FFMPEG,
    [string]$Python = $env:PYTHON
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Python) {
    $candidate = Get-Command python -ErrorAction SilentlyContinue
    if ($candidate) { $Python = $candidate.Source }
}
if (-not $Python) { throw "python not found; set `$env:PYTHON to a Python 3 executable with Pillow" }

if (-not $Ffmpeg) {
    $candidate = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($candidate) { $Ffmpeg = $candidate.Source }
}
if (-not $Ffmpeg) { throw "ffmpeg not found; set `$env:FFMPEG to an ffmpeg binary (any static build works)" }

Write-Host "1/2 rendering slides"
& $Python scripts/render_video_slides.py
if ($LASTEXITCODE -ne 0) { throw "slide rendering failed" }

Write-Host "2/2 encoding video"
Push-Location docs/shots/video
try {
    # Each slide is held for a few seconds; the final slide is listed twice because
    # the concat demuxer ignores the duration of the last entry.
    $durations = @(3.0, 5.0, 5.5, 6.0, 6.0, 5.0, 5.5, 4.0)
    $lines = @()
    for ($i = 0; $i -lt $durations.Count; $i++) {
        $name = "slide{0:D2}.png" -f $i
        $lines += "file '$name'"
        $lines += "duration $($durations[$i])"
    }
    $lines += "file 'slide{0:D2}.png'" -f ($durations.Count - 1)
    Set-Content -Path list.txt -Value $lines -Encoding ascii

    & $Ffmpeg -y -f concat -safe 0 -i list.txt -vf "fps=30,format=yuv420p" `
        -c:v libx264 -preset medium -crf 20 -movflags +faststart "..\veto-demo.mp4"
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed" }
}
finally {
    Pop-Location
}

$video = Get-Item docs/shots/veto-demo.mp4
Write-Host ("done: {0} ({1:N0} bytes)" -f $video.FullName, $video.Length)
