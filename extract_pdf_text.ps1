$ErrorActionPreference = 'Stop'
$inputPdf = Join-Path (Get-Location) 'ChronixEdu_AgentFile.pdf'
$outputTxt = Join-Path (Get-Location) 'ChronixEdu_AgentFile.txt'
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $doc = $word.Documents.Open($inputPdf, $false, $true)
    $doc.SaveAs2($outputTxt, 2)
    $doc.Close()
    $word.Quit()
    Write-Host "SUCCESS: $outputTxt"
} catch {
    Write-Host "WORD_FAIL: $($_.Exception.Message)"
    if ($word) { $word.Quit() | Out-Null }
    exit 1
}
