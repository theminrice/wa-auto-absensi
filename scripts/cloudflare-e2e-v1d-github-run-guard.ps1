$ErrorActionPreference = "Stop"

$Gh = "gh"
$Repo = "theminrice/wa-auto-absensi"
$ExpectedMain = "53b152bc6778bc86914632f60c3db87ee5145e35"
$WorkflowPath = ".github/workflows/wa-attendance-testing-v2.yml"

function Invoke-GhJson {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Endpoint,
        [Parameter(Mandatory = $true)]
        [string]$StopCode
    )

    $Raw = @(& $Gh api $Endpoint) -join "`n"

    if ($LASTEXITCODE -ne 0) {
        throw $StopCode
    }

    if ([string]::IsNullOrWhiteSpace($Raw)) {
        throw "${StopCode}_EMPTY_RESPONSE"
    }

    try {
        return ($Raw | ConvertFrom-Json)
    }
    catch {
        throw "${StopCode}_JSON_PARSE_FAILED"
    }
}

function Get-TargetWorkflowRuns {
    param(
        [Parameter(Mandatory = $true)]
        [string]$StopCode
    )

    $Payload =
        Invoke-GhJson `
            -Endpoint "repos/$Repo/actions/runs?per_page=100" `
            -StopCode $StopCode

    foreach ($Run in @($Payload.workflow_runs)) {
        if (
            $null -ne $Run -and
            [string]$Run.path -eq [string]$WorkflowPath
        ) {
            Write-Output $Run
        }
    }
}

Write-Host "============================================================"
Write-Host "CLOUDFLARE E2E V1D - GITHUB RUN GUARD"
Write-Host "READ ONLY"
Write-Host "NO WORKFLOW DISPATCH"
Write-Host "NO WHATSAPP SEND"
Write-Host "NO GH JQ FILTERS"
Write-Host "============================================================"

$Main =
    Invoke-GhJson `
        -Endpoint "repos/$Repo/commits/main" `
        -StopCode "STOP_GITHUB_MAIN_LOOKUP_FAILED"

$CurrentMain = [string]$Main.sha
Write-Host "CURRENT_MAIN=$CurrentMain"

if ($CurrentMain -ne $ExpectedMain) {
    throw "STOP_MAIN_DRIFT"
}

Write-Host "MAIN_GUARD=PASS"

$WorkflowRuns =
    @(
        Get-TargetWorkflowRuns `
            -StopCode "STOP_ACTIVE_RUN_LOOKUP_FAILED"
    )

$ActiveRuns =
    @(
        foreach ($Run in $WorkflowRuns) {
            if ([string]$Run.status -ne "completed") {
                $Run
            }
        }
    )

Write-Host "TARGET_WORKFLOW_RUN_COUNT=$($WorkflowRuns.Count)"
Write-Host "ACTIVE_RUN_COUNT=$($ActiveRuns.Count)"

foreach ($Run in $ActiveRuns) {
    Write-Host (
        "ACTIVE_RUN_ID={0} STATUS={1} EVENT={2}" -f
        $Run.id,
        $Run.status,
        $Run.event
    )
}

if ($ActiveRuns.Count -ne 0) {
    throw "STOP_ACTIVE_ATTENDANCE_RUN_EXISTS"
}

$BeforeIds =
    @(
        foreach ($Run in $WorkflowRuns) {
            $Id = [string]$Run.id

            if (![string]::IsNullOrWhiteSpace($Id)) {
                $Id
            }
        }
    )

if ($BeforeIds.Count -lt 1) {
    throw "STOP_RUN_SNAPSHOT_EMPTY"
}

Write-Host "BEFORE_RUN_COUNT=$($BeforeIds.Count)"
Write-Host "ACTIVE_RUN_GUARD=PASS"
Write-Host "RUN_SNAPSHOT=PASS"
Write-Host "TRIGGER_ATTEMPTED=NO"
Write-Host "GITHUB_RUN_GUARD_V1D=PASS"
