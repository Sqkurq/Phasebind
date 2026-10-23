# Phasebind full build: Ableton device + signed Ae ZXP.
#   npm run build            (this script)
#   npm run build:nots       (no timestamp server; offline builds)
#
# Output:
#   dist/Phasebind-<version>-ableton/   Max for Live device folder
#   dist/Phasebind-<version>-win.zxp    signed CEP extension (+ .sha256)
[CmdletBinding()]
param(
    [string]$SignTool,
    [string]$CertificatePath,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [switch]$NoTimestamp
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$toolHash = 'FFC2223167225CE61D024EB463FC5AD1A1BE16133F99EF334A646F7311916C98'
$toolUrl = 'https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/ab5e4e3e53a42fad08e1225a22a991bb1ffe73f6/ZXPSignCMD/4.1.3/x64/ZXPSignCmd.exe'
if ($env:OS -ne 'Windows_NT') { throw 'This build script targets Windows.' }
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop

function Invoke-Signer {
    param([string[]]$SignerArguments)
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $log = & $SignTool @SignerArguments 2>&1
        $signExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($signExitCode -ne 0) {
        throw ('ZXPSignCmd failed: ' + ($log -join [Environment]::NewLine))
    }
    $log | ForEach-Object { Write-Host $_ }
}

function Get-Sha256 {
    param([string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}

# ---------------------------------------------------------------- signing tool

if (-not $SignTool) {
    $SignTool = Join-Path $root '.tools\ZXPSignCmd-4.1.3\ZXPSignCmd.exe'
    if (-not (Test-Path -LiteralPath $SignTool)) {
        Write-Host 'Downloading Adobe ZXPSignCmd 4.1.3 (Windows x64)...'
        New-Item -ItemType Directory -Path (Split-Path -Parent $SignTool) -Force | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $toolUrl -OutFile $SignTool
    }
    if ((Get-Sha256 $SignTool) -ne $toolHash.ToLowerInvariant()) {
        throw 'Adobe signing tool checksum mismatch. Remove the cached tool and retry.'
    }
}
$SignTool = (Resolve-Path -LiteralPath $SignTool).Path

# ---------------------------------------------------------------- source build (Ableton device + Ae lib)

Push-Location $root
try {
    & node tools/build.js
    if ($LASTEXITCODE -ne 0) { throw 'Source build failed.' }
} finally { Pop-Location }

$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

# ---------------------------------------------------------------- signing identity

# Local self-signed development identity. The password is DPAPI-encrypted for this
# Windows user; neither key nor password goes into the package.
if ($CertificatePath) {
    $CertificatePath = (Resolve-Path -LiteralPath $CertificatePath).Path
    if (-not $env:ZXP_CERT_PASSWORD) { throw 'Set ZXP_CERT_PASSWORD when supplying -CertificatePath.' }
    $password = $env:ZXP_CERT_PASSWORD
} else {
    $signingDir = Join-Path $root '.signing'
    $CertificatePath = Join-Path $signingDir 'development.p12'
    $passwordFile = Join-Path $signingDir 'development.password.xml'
    if ((Test-Path -LiteralPath $CertificatePath) -xor (Test-Path -LiteralPath $passwordFile)) {
        throw 'Incomplete local signing identity. Restore both files, or use -CertificatePath with ZXP_CERT_PASSWORD.'
    }
    if (-not (Test-Path -LiteralPath $CertificatePath)) {
        New-Item -ItemType Directory -Path $signingDir -Force | Out-Null
        $random = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($random) } finally { $rng.Dispose() }
        $password = [Convert]::ToBase64String($random)
        $securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
        # ASCII temporary path for Adobe's native executable.
        $certTemp = Join-Path ([IO.Path]::GetTempPath()) ('phasebind-cert-' + [Guid]::NewGuid().ToString('N') + '.p12')
        try {
            Invoke-Signer -SignerArguments @('-selfSignedCert', 'JP', 'Japan', 'Phasebind', 'Phasebind Development', $password, $certTemp, '-validityDays', '3650')
            Move-Item -LiteralPath $certTemp -Destination $CertificatePath
            $securePassword | Export-Clixml -LiteralPath $passwordFile
        } finally {
            if (Test-Path -LiteralPath $certTemp) { Remove-Item -LiteralPath $certTemp -Force }
        }
    } else {
        $securePassword = Import-Clixml -LiteralPath $passwordFile
        $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
        try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
    }
}

# ---------------------------------------------------------------- stage, sign, verify

# A fresh ASCII temp workspace keeps removed files out of later builds and keeps
# non-ASCII project paths away from ZXPSignCmd.
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$work = Join-Path $tempRoot ('phasebind-zxp-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $work 'extension'
$archive = Join-Path $work 'package.zxp'
$localCert = Join-Path $work 'signing.p12'
try {
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $root 'aftereffects\extension') -Force | Copy-Item -Destination $stage -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $stage

    $links = Get-ChildItem -LiteralPath $stage -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
    if ($links) { throw 'ZXP staging contains symlinks/reparse points. Use regular files for signing.' }
    Copy-Item -LiteralPath $CertificatePath -Destination $localCert
    $signArguments = @('-sign', $stage, $archive, $localCert, $password)
    if (-not $NoTimestamp) { $signArguments += @('-tsa', $TimestampUrl) }
    Invoke-Signer -SignerArguments $signArguments
    Invoke-Signer -SignerArguments @('-verify', $archive, '-certInfo', '-skipOnlineRevocationChecks')

    $dist = Join-Path $root 'dist'
    New-Item -ItemType Directory -Path $dist -Force | Out-Null
    $output = Join-Path $dist "Phasebind-$version-win.zxp"
    Copy-Item -LiteralPath $archive -Destination $output -Force
    $hash = Get-Sha256 $output
    "$hash  $([IO.Path]::GetFileName($output))" | Set-Content -LiteralPath "$output.sha256" -Encoding ASCII
    Write-Host "ZXP: $output"
    Write-Host "SHA256: $hash"
    if ($NoTimestamp) { Write-Warning 'No timestamp: this development package expires with its signing certificate.' }
} finally {
    $password = $null
    $resolvedWork = [IO.Path]::GetFullPath($work)
    $expectedPrefix = Join-Path $tempRoot 'phasebind-zxp-'
    if ($resolvedWork.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedWork)) {
        Remove-Item -LiteralPath $resolvedWork -Recurse -Force
    }
}
