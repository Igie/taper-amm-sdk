# Builds `taper-jupiter` against a `jupiter-amm-interface` that has
# `Swap::Taper`, so that "one line to change when Jupiter ships it" is a tested
# claim and not a promise.
#
# `jupiter/upstream/` holds the patch we are asking Jupiter to take. This copies
# the published interface out of the cargo registry, applies that patch, points
# `[patch.crates-io]` at the copy, and runs the crate's tests with
# `--features pending-swap-variant` - the feature that switches `taper_swap`
# from an honest error to the real variant.
#
# Two things it has to work around, both worth knowing before editing it.
#
# **Patching re-resolves.** Cargo drops the lock's choices for a patched
# package's own dependencies and picks again, and `jupiter-amm-interface` asks
# for `solana-pubkey >= 2` and `solana-instruction >= 2`. The graph already
# holds 2.x copies of both - pulled in by the `solana-account-decoder = "~2"`
# steer in `jupiter/Cargo.toml` - so a re-resolve answers `>= 2` with those,
# and the interface ends up on a different `Pubkey` and `AccountMeta` than our
# crates. Twenty type errors, none of them about the variant. So the copy's
# requirements are pinned to exactly what `jupiter/Cargo.lock` already resolved,
# which holds everything but the variant constant.
#
# **The lock moves anyway.** Cargo rewrites `jupiter/Cargo.lock` to record the
# patch. It is restored afterwards, so a run leaves `git status` clean.

param(
    # Which published interface to patch. `0.6.1` is what the workspace pins;
    # `1.0.0-beta.0` is the fallback D2 named, and has its own patch.
    [ValidateSet('0.6.1', '1.0.0-beta.0')]
    [string]$Version = '0.6.1'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$jupiter = Join-Path $root 'jupiter'
$patch = Join-Path $jupiter "upstream\swap-taper-$Version.patch"
$lock = Join-Path $jupiter 'Cargo.lock'

if (-not (Test-Path $patch)) { throw "No patch for $Version at $patch" }

# The published source, as cargo unpacked it. The registry directory carries a
# hash in its name, so it is searched for rather than spelled out.
$registry = Join-Path $HOME '.cargo\registry\src'
$source = Get-ChildItem -Path $registry -Directory |
    ForEach-Object { Join-Path $_.FullName "jupiter-amm-interface-$Version" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
if (-not $source) {
    throw "jupiter-amm-interface $Version is not in $registry. Run ``cargo fetch`` in jupiter\ first."
}

# Everything below `target/` is ignored, so the copy is not something to clean
# up by hand.
$dest = Join-Path $jupiter "target\upstream\jupiter-amm-interface-$Version"
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
Copy-Item -Recurse $source $dest
# Registry sources are checked out read-only.
Get-ChildItem -Recurse -File $dest | ForEach-Object { $_.IsReadOnly = $false }

# `git apply` run inside a repository resolves paths from the repository root
# and silently skips anything outside the current directory, so `--directory`
# does the work instead of a `Set-Location`.
$relative = "jupiter/target/upstream/jupiter-amm-interface-$Version"
git -C $root apply -p1 --directory=$relative $patch
if ($LASTEXITCODE -ne 0) { throw "git apply failed - has the interface moved under the patch?" }
if (-not (Select-String -Path (Join-Path $dest 'src\swap.rs') -Pattern '^\s*Taper \{' -Quiet)) {
    throw "the patch applied but Swap::Taper is not in swap.rs"
}

# What `jupiter/Cargo.lock` already resolved for the interface's own
# dependencies. Read rather than written down, so this cannot drift from the
# lock the unpatched build uses.
$lockLines = Get-Content $lock
$versionsByName = @{}
$name = $null
foreach ($line in $lockLines) {
    if ($line -match '^name = "(.+)"$') { $name = $Matches[1]; continue }
    if ($line -match '^version = "(.+)"$' -and $name) {
        if (-not $versionsByName.ContainsKey($name)) { $versionsByName[$name] = @() }
        $versionsByName[$name] += $Matches[1]
        $name = $null
    }
}

$pins = @{}
$inBlock = $false
$isTarget = $false
$inDeps = $false
foreach ($line in $lockLines) {
    if ($line -eq '[[package]]') { $inBlock = $true; $isTarget = $false; $inDeps = $false; continue }
    if (-not $inBlock) { continue }
    if ($line -eq 'name = "jupiter-amm-interface"') { $isTarget = $true; continue }
    # The lock can only hold the version the workspace asks for, so a block for
    # any other one is not ours to read.
    if ($isTarget -and $line -match '^version = ') {
        $isTarget = $line -eq "version = `"$Version`""
        continue
    }
    if ($isTarget -and $line -eq 'dependencies = [') { $inDeps = $true; continue }
    if ($inDeps) {
        if ($line -eq ']') { break }
        # ` "solana-pubkey 4.3.0",` or ` "anyhow",` when the name is unambiguous.
        $entry = $line.Trim().Trim(',').Trim('"')
        $parts = $entry.Split(' ')
        $depName = $parts[0]
        if (-not $depName.StartsWith('solana-')) { continue }
        $pins[$depName] = if ($parts.Count -gt 1) { $parts[1] } else { $versionsByName[$depName][0] }
    }
}
# No block means this is not the version the workspace pins, so the lock has
# nothing to hold constant and the resolve below is a fresh one. That is the
# `1.0.0-beta.0` case, and it needs no pinning: its own requirements are tight
# enough to land on one `Pubkey`.
if ($pins.Count -gt 0) {
    # Rewrite the copy's requirements to those exact versions. The manifest
    # cargo unpacks is the normalised one, so every dependency is its own
    # `[dependencies.<name>]` table.
    $manifest = Join-Path $dest 'Cargo.toml'
    $out = New-Object System.Collections.Generic.List[string]
    $pinning = $null
    foreach ($line in Get-Content $manifest) {
        if ($line -match '^\[dependencies\.(.+)\]$') {
            $pinning = if ($pins.ContainsKey($Matches[1])) { $pins[$Matches[1]] } else { $null }
        }
        elseif ($line.StartsWith('[')) { $pinning = $null }
        elseif ($pinning -and $line -match '^version = ') {
            $out.Add("version = `"=$pinning`"")
            $pinning = $null
            continue
        }
        $out.Add($line)
    }
    Set-Content -Path $manifest -Value $out -Encoding utf8
    Write-Host "pinned $($pins.Count) solana-* requirements to the versions in Cargo.lock:"
    $pins.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host "  $($_.Name) = $($_.Value)" }
}
else {
    Write-Host "$Version is not the version Cargo.lock resolved; letting it resolve fresh."
}

$config = Join-Path $jupiter 'target\upstream\patch.toml'
@(
    '[patch.crates-io]'
    "jupiter-amm-interface = { path = `"$($dest -replace '\\', '/')`" }"
) | Set-Content -Path $config -Encoding utf8

# A patch only applies where its version satisfies the requirement, so a
# version the workspace does not ask for needs that one line moved first -
# which is the same one line the plan says a switch costs.
$workspaceManifest = Join-Path $jupiter 'Cargo.toml'
$lockBackup = Join-Path $jupiter 'target\upstream\Cargo.lock.before'
$manifestBackup = Join-Path $jupiter 'target\upstream\Cargo.toml.before'
Copy-Item $lock $lockBackup -Force
Copy-Item $workspaceManifest $manifestBackup -Force
try {
    (Get-Content $workspaceManifest) -replace '^jupiter-amm-interface = ".*"$', "jupiter-amm-interface = `"$Version`"" |
        Set-Content -Path $workspaceManifest -Encoding utf8

    Push-Location $jupiter
    cargo test -p taper-jupiter --features pending-swap-variant --config $config
    $failed = $LASTEXITCODE -ne 0
}
finally {
    Pop-Location
    Copy-Item $lockBackup $lock -Force
    Copy-Item $manifestBackup $workspaceManifest -Force
}
if ($failed) { throw "the patched build failed" }

Write-Host ""
Write-Host "Swap::Taper builds against jupiter-amm-interface $Version, and Cargo.lock is unchanged."
