$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices()
$voice = $voices | Where-Object { $_.VoiceInfo.Culture.Name -eq 'ja-JP' } | Select-Object -First 1
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$outputPath = Join-Path $PSScriptRoot '..\.runtime\test-speech.wav'
$synth.SetOutputToWaveFile($outputPath, $format)
if ($voice) {
  $synth.SelectVoice($voice.VoiceInfo.Name)
  $synth.Speak('こんにちは。今日は音声認識アプリの動作を確認しています。明日の会議は午後三時からです。')
  Write-Output ('Japanese voice: ' + $voice.VoiceInfo.Name)
} else {
  $synth.Speak('Hello. This is a real time transcription test. The meeting starts tomorrow at three in the afternoon.')
  Write-Output 'English voice selected'
}
Write-Output $outputPath
$englishVoice = $voices | Where-Object { $_.VoiceInfo.Culture.Name -eq 'en-US' } | Select-Object -First 1
if ($englishVoice) {
  $englishOutputPath = Join-Path $PSScriptRoot '..\.runtime\test-speech-en.wav'
  $synth.SetOutputToWaveFile($englishOutputPath, $format)
  $synth.SelectVoice($englishVoice.VoiceInfo.Name)
  $synth.Speak('Hello. Today we are testing live translation. The meeting starts tomorrow at three in the afternoon. Please bring the report to the meeting.')
  Write-Output ('English voice: ' + $englishVoice.VoiceInfo.Name)
  Write-Output $englishOutputPath
}
$synth.Dispose()

