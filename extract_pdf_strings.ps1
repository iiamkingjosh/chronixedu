$ErrorActionPreference = 'Stop'
$input = Join-Path (Get-Location) 'ChronixEdu_AgentFile.pdf'
$output = Join-Path (Get-Location) 'ChronixEdu_AgentFile_strings.txt'
$bytes = [System.IO.File]::ReadAllBytes($input)
$builder = New-Object System.Text.StringBuilder
foreach ($b in $bytes) {
    if ($b -ge 32 -and $b -le 126) {
        $builder.Append([char]$b) | Out-Null
    } else {
        $builder.Append(' ') | Out-Null
    }
}
$text = $builder.ToString() -replace ' {2,}', ' '
$lines = $text -split '[\r\n]'
$lines | Where-Object { $_.Length -ge 20 } | Set-Content $output -Encoding UTF8
Write-Host "WROTE: $output"
