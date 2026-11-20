# Signs in to Certum SimplySign on a GitHub Windows runner, so signtool can use the cloud code-signing certificate
# (Certum "Open Source Code Signing in the cloud"). Used by .github/workflows/release.yml; does nothing locally.
#
# Environment (GitHub secrets — set by the owner, never stored in the repository):
#   CERTUM_USERNAME  the SimplySign account (e-mail)
#   CERTUM_OTP       the one-time-password seed from SimplySign's activation QR code: preferably the whole
#                    otpauth://totp/...?secret=...&algorithm=... address, or only the Base32 secret
# Writes CERTUM_THUMBPRINT and SIGNTOOL to $env:GITHUB_ENV for the packaging step (scripts/sign-win.cjs).
#
# SimplySign Desktop has no command-line login: the script starts it and types the account and a fresh one-time
# code into its window, then waits until the certificate (with its private key) is in the user's certificate store.
#   -SelfTest  checks only the one-time-code part against RFC 6238's test values (used by the E2E workflow).
param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'

# MARK: - One-time codes (RFC 6238)

# SendKeys treats + ^ % ~ ( ) { } [ ] as commands.
function Escape-Keys([string]$s) { return ($s -replace '([+^%~(){}\[\]])', '{$1}') }


function ConvertFrom-Base32([string]$s) {
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  $clean = ($s.ToUpperInvariant() -replace '[^A-Z2-7]', '')
  # Plain arithmetic (PowerShell's shift operators keep the operand's narrow type).
  [long]$bits = 0; [long]$value = 0; $out = New-Object System.Collections.Generic.List[byte]
  foreach ($ch in $clean.ToCharArray()) {
    $value = $value * 32 + $alphabet.IndexOf($ch); $bits += 5
    if ($bits -ge 8) {
      $bits -= 8
      [long]$p = [Math]::Pow(2, $bits)
      $out.Add([byte]([Math]::Floor($value / $p) % 256))
      $value = $value % $p
    }
  }
  return ,$out.ToArray()
}

$period = 30; $digits = 6; $key = $null

function Get-Totp([string]$algorithm, [long]$time = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(), [byte[]]$keyBytes = $script:key, [int]$n = $script:digits) {
  [long]$counter = [Math]::Floor([double]$time / [double]$period)
  # The counter as 8 big-endian bytes.
  $msg = New-Object byte[] 8
  for ($i = 7; $i -ge 0; $i--) { $msg[$i] = [byte]($counter % 256); $counter = [Math]::Floor($counter / 256) }
  $hmac = switch ($algorithm) { 'SHA1' { New-Object System.Security.Cryptography.HMACSHA1 } 'SHA512' { New-Object System.Security.Cryptography.HMACSHA512 } default { New-Object System.Security.Cryptography.HMACSHA256 } }
  $hmac.Key = $keyBytes
  $h = $hmac.ComputeHash($msg)
  # Dynamic truncation: four bytes at the offset given by the last nibble, as a big-endian number without the top bit.
  $o = [int]($h[$h.Length - 1] -band 0x0F)
  [long]$code = ([long]($h[$o] -band 0x7F)) * 16777216 + ([long]$h[$o + 1]) * 65536 + ([long]$h[$o + 2]) * 256 + [long]$h[$o + 3]
  [long]$mod = 1; for ($i = 0; $i -lt $n; $i++) { $mod *= 10 }
  return ($code % $mod).ToString().PadLeft($n, '0')
}

if ($SelfTest) {
  # RFC 6238 appendix B (8 digits, 30 s) and a Base32 round trip.
  $ascii = [Text.Encoding]::ASCII
  $period = 30
  $cases = @(
    @('SHA1', '12345678901234567890', 59, '94287082'), @('SHA1', '12345678901234567890', 1111111109, '07081804'),
    @('SHA256', '12345678901234567890123456789012', 59, '46119246'), @('SHA256', '12345678901234567890123456789012', 1234567890, '91819424'),
    @('SHA512', '1234567890123456789012345678901234567890123456789012345678901234', 2000000000, '38618901'))
  foreach ($c in $cases) {
    $got = Get-Totp $c[0] $c[2] $ascii.GetBytes($c[1]) 8
    if ($got -ne $c[3]) { throw "TOTP $($c[0]) at $($c[2]): $got, expected $($c[3])" }
  }
  $b32 = ConvertFrom-Base32 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  if ($ascii.GetString($b32) -ne '12345678901234567890') { throw 'Base32 decoding is wrong' }
  if ((Escape-Keys 'a+b(c)~') -ne 'a{+}b{(}c{)}{~}') { throw 'SendKeys escaping is wrong' }
  Write-Host 'certum-login self-test passed'
  exit 0
}

$user = $env:CERTUM_USERNAME
$otp = $env:CERTUM_OTP
if (-not $user -or -not $otp) { throw 'CERTUM_USERNAME and CERTUM_OTP are needed' }

# The seed, and from an otpauth address its algorithm / digits / period.
$secret = $otp; $algorithms = @('SHA256', 'SHA1'); $digits = 6; $period = 30
if ($otp -match '^otpauth://') {
  $query = ($otp -split '\?', 2)[1]
  foreach ($pair in $query -split '&') {
    $k, $v = $pair -split '=', 2
    $v = [Uri]::UnescapeDataString($v)
    switch ($k.ToLowerInvariant()) {
      'secret' { $secret = $v }
      'algorithm' { $algorithms = @($v.ToUpperInvariant()) }
      'digits' { $digits = [int]$v }
      'period' { $period = [int]$v }
    }
  }
}
$key = ConvertFrom-Base32 $secret
if ($key.Length -lt 10) { throw 'CERTUM_OTP does not look like a TOTP seed' }



# MARK: - SimplySign Desktop

$version = if ($env:SIMPLYSIGN_VERSION) { $env:SIMPLYSIGN_VERSION } else { '9.4.4.92' }
$exe = "${env:ProgramFiles}\Certum\SimplySign Desktop\SimplySignDesktop.exe"
if (-not (Test-Path $exe)) {
  $msi = Join-Path $env:RUNNER_TEMP 'SimplySignDesktop.msi'
  $url = "https://files.certum.eu/software/SimplySignDesktop/Windows/$version/SimplySignDesktop-$version-64-bit-en.msi"
  for ($i = 0; $i -lt 3; $i++) { try { Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing; break } catch { if ($i -eq 2) { throw } Start-Sleep 5 } }
  $p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "SimplySign Desktop did not install (msiexec $($p.ExitCode))" }
  $exe = (Get-ChildItem "${env:ProgramFiles}\Certum" -Recurse -Filter SimplySignDesktop.exe | Select-Object -First 1).FullName
}

function Find-Certificate {
  Get-ChildItem Cert:\CurrentUser\My | Where-Object {
    $_.HasPrivateKey -and $_.Issuer -match 'Certum' -and ($_.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq '1.3.6.1.5.5.7.3.3' })
  } | Sort-Object NotAfter -Descending | Select-Object -First 1
}


$shell = New-Object -ComObject WScript.Shell
$cert = $null
foreach ($algorithm in $algorithms) {
  Get-Process SimplySignDesktop -ErrorAction SilentlyContinue | Stop-Process -Force
  $proc = Start-Process $exe -PassThru
  for ($i = 0; $i -lt 30 -and -not $proc.MainWindowHandle; $i++) { Start-Sleep -Milliseconds 500; $proc.Refresh() }
  Start-Sleep 3
  # A code with at least five seconds left, typed at once.
  $left = $period - ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() % $period)
  if ($left -lt 6) { Start-Sleep ($left + 1) }
  for ($i = 0; $i -lt 10 -and -not $shell.AppActivate($proc.Id); $i++) { Start-Sleep -Milliseconds 500 }
  $shell.SendKeys((Escape-Keys $user)); Start-Sleep -Milliseconds 300
  $shell.SendKeys('{TAB}'); Start-Sleep -Milliseconds 300
  $shell.SendKeys((Get-Totp $algorithm)); Start-Sleep -Milliseconds 300
  $shell.SendKeys('{ENTER}')
  for ($i = 0; $i -lt 45 -and -not $cert; $i++) { Start-Sleep 2; $cert = Find-Certificate }
  if ($cert) { break }
  Write-Host "No certificate after signing in with $algorithm codes"
}
if (-not $cert) { throw 'The Certum certificate did not appear: check CERTUM_USERNAME / CERTUM_OTP' }

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe |
  Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe not found' }

Write-Host "Signing with: $($cert.Subject) (valid until $($cert.NotAfter.ToString('yyyy-MM-dd')))"
"CERTUM_THUMBPRINT=$($cert.Thumbprint)" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
"SIGNTOOL=$($signtool.FullName)" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
