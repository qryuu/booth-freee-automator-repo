<#
.SYNOPSIS
    九龍工房 新規クライアント用マルチテナント自動プロビジョニングスクリプト
.DESCRIPTION
    新規クリエイター（作家）向けに、独立したS3バケット、Secrets Manager、
    最小権限IAMロール、Lambda関数（予約同時実行数: 1）、および推測不能Function URLを
    一括で自動構築し、顧客提示用のポータルURLを出力します。
.PARAMETER ClientId
    クライアント識別子（英小文字、数字、ハイフン。小文字英数字で開始・終了。例: author-001）
.PARAMETER FreeeClientId
    freeeアプリのClient ID
.PARAMETER FreeeClientSecret
    freeeアプリのClient Secret
.PARAMETER FreeeRefreshToken
    freee初期OAuthリフレッシュトークン
.PARAMETER FreeeCompanyId
    freee事業所ID
.PARAMETER FreeeWalletableId
    freee決済口座（BOOTH口座）ID
.PARAMETER PartnerName
    （任意）freee取引先名（例: BOOTH）
.PARAMETER ItemNameUriage
    （任意）売上品目名
.PARAMETER ItemNameTesuryo
    （任意）手数料品目名
.PARAMETER Region
    デプロイ先AWSリージョン（既定値: ap-northeast-1）
.PARAMETER ZipPath
    Lambdaデプロイ用ZIPファイルパス（既定値: deployment.zip）
.PARAMETER ForceUpdateSecret
    既存シークレットが存在する場合でも初期リフレッシュトークンで強制上書きするフラグ
.PARAMETER DryRun
    AWSリソースを作成せず、パラメータ検証と実行計画の表示のみを行う
#>
[CmdletBinding()]
param (
    [Parameter(Mandatory = $true, HelpMessage = "クライアント識別子（例: author-001）")]
    [ValidateScript({
        if ($_ -cnotmatch '^[a-z0-9][a-z0-9\-]{1,29}[a-z0-9]$') {
            throw "ClientId は3〜31文字の英小文字・数字・ハイフンで、英小文字または数字で開始・終了する必要があります（大文字不可）: $_"
        }
        $true
    })]
    [string]$ClientId,

    [Parameter(Mandatory = $true, HelpMessage = "freee Client ID")]
    [string]$FreeeClientId,

    [Parameter(Mandatory = $true, HelpMessage = "freee Client Secret")]
    [string]$FreeeClientSecret,

    [Parameter(Mandatory = $true, HelpMessage = "freee Initial Refresh Token")]
    [string]$FreeeRefreshToken,

    [Parameter(Mandatory = $true, HelpMessage = "freee Company ID (事業所ID)")]
    [string]$FreeeCompanyId,

    [Parameter(Mandatory = $true, HelpMessage = "freee Walletable ID (口座ID)")]
    [string]$FreeeWalletableId,

    [Parameter(Mandatory = $false)]
    [string]$PartnerName = "",

    [Parameter(Mandatory = $false)]
    [string]$ItemNameUriage = "",

    [Parameter(Mandatory = $false)]
    [string]$ItemNameTesuryo = "",

    [Parameter(Mandatory = $false)]
    [string]$Region = "ap-northeast-1",

    [Parameter(Mandatory = $false)]
    [string]$ZipPath = "deployment.zip",

    [Parameter(Mandatory = $false)]
    [switch]$ForceUpdateSecret,

    [Parameter(Mandatory = $false)]
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# UTF-8 出力固定 & デフォルトリージョン & AWS CLI file:// 読み込みエンコード固定
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:AWS_DEFAULT_REGION = $Region
$env:AWS_CLI_FILE_ENCODING = 'UTF-8'

# 作成した一時ファイルの追跡（クリーンアップ用）
$script:TempFiles = [System.Collections.Generic.List[string]]::new()

function New-TempJsonFile {
    param([string]$JsonContent)
    $tempPath = [System.IO.Path]::GetTempFileName()
    # AWS CLI および JSON.parse のために BOM なし UTF-8 で書き出す
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tempPath, $JsonContent, $utf8NoBom)
    $script:TempFiles.Add($tempPath)
    return $tempPath
}

# ----------------------------------------------------
# ヘルパー関数: AWS CLI の安全な実行（PS 5.1/7.x 互換 & $LASTEXITCODE 検証）
# ----------------------------------------------------
function Invoke-AwsCli {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$CliArgs
    )
    $origEap = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & aws --region $Region @CliArgs 2>&1
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            $errText = ($output | Out-String).Trim()
            throw "AWS CLI command failed (exit code $exitCode): aws $($CliArgs -join ' ')`n$errText"
        }
        return $output
    } finally {
        $ErrorActionPreference = $origEap
    }
}

function Test-AwsResourceExists {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$CliArgs
    )
    $origEap = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'SilentlyContinue'
        $null = & aws --region $Region @CliArgs 2>$null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $origEap
    }
}

try {
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host " 九龍工房 テナント自動プロビジョニングツール" -ForegroundColor Cyan
    Write-Host " Client ID: $ClientId" -ForegroundColor Cyan
    Write-Host " Region   : $Region" -ForegroundColor Cyan
    Write-Host " Mode     : $(if ($DryRun) { 'DRY-RUN (計画確認のみ)' } else { '本番プロビジョニング実行' })" -ForegroundColor Cyan
    Write-Host "==========================================================" -ForegroundColor Cyan

    # リソース命名規約
    $bucketName = "booth-freee-csv-upload-$ClientId"
    $secretName = "booth-freee-automator/credentials-$ClientId"
    $roleName   = "booth-freee-automator-role-$ClientId"
    $lambdaName = "booth-freee-automator-$ClientId"
    $policyName = "TenantAccessPolicy"

    Write-Host "`n[1/7] リソース設計の確認" -ForegroundColor Yellow
    Write-Host "  - S3 Bucket       : $bucketName"
    Write-Host "  - Secrets Manager : $secretName"
    Write-Host "  - IAM Role        : $roleName"
    Write-Host "  - Lambda Function : $lambdaName"
    Write-Host "  - Target Region   : $Region"

    if ($DryRun) {
        Write-Host "`n[DRY-RUN] パラメータ設計の検証は正常です。リソースの作成は行いません。" -ForegroundColor Green
        return
    }

    # AWS アカウントIDの取得
    $awsAccountId = (Invoke-AwsCli sts get-caller-identity --query "Account" --output text | Out-String).Trim()
    if (-not $awsAccountId) {
        throw "AWS アカウントIDの取得に失敗しました。AWS CLI の認証情報を確認してください。"
    }
    Write-Host "  - AWS Account ID  : $awsAccountId"

    # ZIPファイルの事前存在確認
    if (-not (Test-Path $ZipPath)) {
        throw "デプロイ用ZIPファイルが見つかりません: $ZipPath `n先に deployment.zip を配置してください。"
    }

    # ----------------------------------------------------
    # Step 2: S3 バケットの作成 & セキュリティ完全保護
    # ----------------------------------------------------
    Write-Host "`n[2/7] S3 バケットの作成 & セキュリティ完全保護..." -ForegroundColor Yellow

    $bucketExists = Test-AwsResourceExists s3api head-bucket --bucket $bucketName --expected-bucket-owner $awsAccountId
    if ($bucketExists) {
        Write-Host "  - 既存 S3 バケットを検出: $bucketName" -ForegroundColor DarkGray
    } else {
        if ($Region -eq "us-east-1") {
            Invoke-AwsCli s3api create-bucket --bucket $bucketName | Out-Null
        } else {
            Invoke-AwsCli s3api create-bucket --bucket $bucketName --create-bucket-configuration LocationConstraint=$Region | Out-Null
        }
        Write-Host "  ✔ S3 バケットを作成しました: $bucketName" -ForegroundColor Green
    }

    # パブリックアクセスの完全ブロック
    Invoke-AwsCli s3api put-public-access-block --bucket $bucketName --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" | Out-Null
    Write-Host "  ✔ S3 パブリックアクセス完全ブロックを適用しました" -ForegroundColor Green

    # デフォルト暗号化 (SSE-S3 AES256) - file:// 経由で安全に適用
    $encJson = '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
    $encFile = New-TempJsonFile $encJson
    Invoke-AwsCli s3api put-bucket-encryption --bucket $bucketName --server-side-encryption-configuration "file://$encFile" | Out-Null
    Write-Host "  ✔ S3 サーバーサイド暗号化 (AES256) を設定しました" -ForegroundColor Green

    # TLS (HTTPS) 強制バケットポリシー - file:// 経由で安全に適用
    $tlsPolicy = @"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EnforceTLSRequestsOnly",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::$bucketName",
        "arn:aws:s3:::$bucketName/*"
      ],
      "Condition": {
        "Bool": {
          "aws:SecureTransport": "false"
        }
      }
    }
  ]
}
"@
    $tlsFile = New-TempJsonFile $tlsPolicy
    Invoke-AwsCli s3api put-bucket-policy --bucket $bucketName --policy "file://$tlsFile" | Out-Null
    Write-Host "  ✔ S3 非暗号化アクセス (HTTP) 遮断ポリシーを適用しました" -ForegroundColor Green

    # タグ付け
    Invoke-AwsCli s3api put-bucket-tagging --bucket $bucketName --tagging "TagSet=[{Key=Project,Value=booth-freee-automator},{Key=Environment,Value=production},{Key=Client,Value=$ClientId}]" | Out-Null
    Write-Host "  ✔ S3 バケットにタグを付与しました" -ForegroundColor Green

    # ----------------------------------------------------
    # Step 3: Secrets Manager シークレットの作成 / 保護
    # ----------------------------------------------------
    Write-Host "`n[3/7] Secrets Manager シークレットの構成..." -ForegroundColor Yellow

    $secretExists = Test-AwsResourceExists secretsmanager describe-secret --secret-id $secretName
    $secretArn = $null

    if ($secretExists) {
        $secretArn = (Invoke-AwsCli secretsmanager describe-secret --secret-id $secretName --query "ARN" --output text | Out-String).Trim()
        if ($ForceUpdateSecret) {
            Write-Host "  - [-ForceUpdateSecret] が指定されたため、シークレットの初期値を上書きします..." -ForegroundColor DarkYellow
            $secretPayload = @{
                FREEE_CLIENT_ID     = $FreeeClientId
                FREEE_CLIENT_SECRET = $FreeeClientSecret
                FREEE_REFRESH_TOKEN = $FreeeRefreshToken
                FREEE_COMPANY_ID    = $FreeeCompanyId
                FREEE_WALLETABLE_ID = $FreeeWalletableId
            }
            if ($PartnerName) { $secretPayload["PARTNER_NAME"] = $PartnerName }
            if ($ItemNameUriage) { $secretPayload["ITEM_NAME_URIAGE"] = $ItemNameUriage }
            if ($ItemNameTesuryo) { $secretPayload["ITEM_NAME_TESURYO"] = $ItemNameTesuryo }
            $jsonStr = $secretPayload | ConvertTo-Json -Compress
            $secFile = New-TempJsonFile $jsonStr
            Invoke-AwsCli secretsmanager put-secret-value --secret-id $secretName --secret-string "file://$secFile" | Out-Null
            Write-Host "  ✔ シークレットの値を上書き更新しました" -ForegroundColor Green
        } else {
            Write-Host "  ✔ 既存シークレットを維持します（稼働中トークンの保護のため上書きスキップ）" -ForegroundColor Green
        }
    } else {
        $secretPayload = @{
            FREEE_CLIENT_ID     = $FreeeClientId
            FREEE_CLIENT_SECRET = $FreeeClientSecret
            FREEE_REFRESH_TOKEN = $FreeeRefreshToken
            FREEE_COMPANY_ID    = $FreeeCompanyId
            FREEE_WALLETABLE_ID = $FreeeWalletableId
        }
        if ($PartnerName) { $secretPayload["PARTNER_NAME"] = $PartnerName }
        if ($ItemNameUriage) { $secretPayload["ITEM_NAME_URIAGE"] = $ItemNameUriage }
        if ($ItemNameTesuryo) { $secretPayload["ITEM_NAME_TESURYO"] = $ItemNameTesuryo }
        $jsonStr = $secretPayload | ConvertTo-Json -Compress
        $secFile = New-TempJsonFile $jsonStr

        $secretArn = (Invoke-AwsCli secretsmanager create-secret `
            --name $secretName `
            --description "booth-freee-automator credentials for $ClientId" `
            --secret-string "file://$secFile" `
            --tags Key=Project,Value=booth-freee-automator Key=Environment,Value=production Key=Client,Value=$ClientId `
            --query "ARN" --output text | Out-String).Trim()
        Write-Host "  ✔ Secrets Manager シークレットを新規作成しました: $secretName" -ForegroundColor Green
    }

    # ----------------------------------------------------
    # Step 4: 最小権限 IAM ロールの作成
    # ----------------------------------------------------
    Write-Host "`n[4/7] テナント分離 IAM ロールの構成..." -ForegroundColor Yellow

    $trustPolicy = @"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
"@
    $trustFile = New-TempJsonFile $trustPolicy

    $roleExists = Test-AwsResourceExists iam get-role --role-name $roleName
    $roleArn = $null

    if ($roleExists) {
        $roleArn = (Invoke-AwsCli iam get-role --role-name $roleName --query "Role.Arn" --output text | Out-String).Trim()
        Write-Host "  - 既存 IAM ロールを検出: $roleName" -ForegroundColor DarkGray
    } else {
        $roleArn = (Invoke-AwsCli iam create-role `
            --role-name $roleName `
            --assume-role-policy-document "file://$trustFile" `
            --tags Key=Project,Value=booth-freee-automator Key=Environment,Value=production Key=Client,Value=$ClientId `
            --query "Role.Arn" --output text | Out-String).Trim()
        Write-Host "  ✔ IAM ロールを作成しました: $roleName" -ForegroundColor Green

        # 基本実行ポリシー（CloudWatch Logs出力）のアタッチ
        Invoke-AwsCli iam attach-role-policy --role-name $roleName --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" | Out-Null
        Write-Host "  ✔ AWSLambdaBasicExecutionRole をアタッチしました" -ForegroundColor Green
    }

    # テナント専用インラインポリシー（対象S3と対象Secretのみに厳密制限）
    $tenantPolicyDoc = @"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowTenantSecretAccess",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:UpdateSecret"
      ],
      "Resource": "$secretArn"
    },
    {
      "Sid": "AllowTenantS3Access",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::$bucketName/*"
    }
  ]
}
"@
    $tenantFile = New-TempJsonFile $tenantPolicyDoc
    Invoke-AwsCli iam put-role-policy --role-name $roleName --policy-name $policyName --policy-document "file://$tenantFile" | Out-Null
    Write-Host "  ✔ 最小権限インラインポリシー ($policyName) を設定しました" -ForegroundColor Green

    # ----------------------------------------------------
    # Step 5: Lambda 関数のデプロイ（伝播リトライ付き）
    # ----------------------------------------------------
    Write-Host "`n[5/7] Lambda 関数のデプロイ..." -ForegroundColor Yellow

    $envMap = @{
        UPLOAD_BUCKET_NAME = $bucketName
        SECRET_NAME        = $secretName
    }
    if ($PartnerName) { $envMap["PARTNER_NAME"] = $PartnerName }
    if ($ItemNameUriage) { $envMap["ITEM_NAME_URIAGE"] = $ItemNameUriage }
    if ($ItemNameTesuryo) { $envMap["ITEM_NAME_TESURYO"] = $ItemNameTesuryo }
    $envPayload = @{ Variables = $envMap }
    $envJson = $envPayload | ConvertTo-Json -Compress
    $envFile = New-TempJsonFile $envJson

    $lambdaExists = Test-AwsResourceExists lambda get-function --function-name $lambdaName

    if (-not $lambdaExists) {
        Write-Host "  - Lambda 関数を新規作成中 (IAM 伝播待機リトライループ付き)..." -ForegroundColor DarkGray
        $maxRetries = 6
        $created = $false
        for ($i = 1; $i -le $maxRetries; $i++) {
            try {
                Invoke-AwsCli lambda create-function `
                    --function-name $lambdaName `
                    --runtime "nodejs22.x" `
                    --role $roleArn `
                    --handler "index.handler" `
                    --timeout 30 `
                    --memory-size 1024 `
                    --zip-file "fileb://$ZipPath" `
                    --environment "file://$envFile" `
                    --tags "Project=booth-freee-automator,Environment=production,Client=$ClientId" | Out-Null
                $created = $true
                Write-Host "  ✔ Lambda 関数を作成しました: $lambdaName" -ForegroundColor Green
                break
            } catch {
                if ($i -lt $maxRetries -and $_.Exception.Message -match "cannot be assumed") {
                    $waitTime = $i * 4
                    Write-Host "  ⏳ IAM ロール伝播待ち... ($waitTime 秒後に再試行 $i/$maxRetries)" -ForegroundColor DarkGray
                    Start-Sleep -Seconds $waitTime
                } else {
                    throw $_
                }
            }
        }
        if (-not $created) {
            throw "Lambda 関数の作成に失敗しました (IAM ロール伝播タイムアウト)。"
        }
    } else {
        Write-Host "  - 既存 Lambda 関数を更新中..." -ForegroundColor DarkGray
        Invoke-AwsCli lambda update-function-code --function-name $lambdaName --zip-file "fileb://$ZipPath" | Out-Null
        Invoke-AwsCli lambda wait function-updated --function-name $lambdaName | Out-Null
        Invoke-AwsCli lambda update-function-configuration --function-name $lambdaName --environment "file://$envFile" --role $roleArn | Out-Null
        Write-Host "  ✔ Lambda 関数のコードと設定を更新しました" -ForegroundColor Green
    }

    Invoke-AwsCli lambda wait function-active --function-name $lambdaName | Out-Null
    Invoke-AwsCli lambda wait function-updated --function-name $lambdaName | Out-Null

    # ----------------------------------------------------
    # Step 6: 予約同時実行数の設定 (P0 / 並列競合・トークン失効防止)
    # ----------------------------------------------------
    Write-Host "`n[6/7] 予約同時実行数（Reserved Concurrency: 1）の設定..." -ForegroundColor Yellow
    Invoke-AwsCli lambda put-function-concurrency --function-name $lambdaName --reserved-concurrent-executions 1 | Out-Null
    Write-Host "  ✔ 予約同時実行数を '1' に設定しました（並列競合・トークン破壊を物理遮断）" -ForegroundColor Green

    # ----------------------------------------------------
    # Step 7: Function URL (Capability URL) の払い出し
    # ----------------------------------------------------
    Write-Host "`n[7/7] 専用 Function URL（Capability URL）の払い出し..." -ForegroundColor Yellow

    $functionUrl = $null
    $urlExists = Test-AwsResourceExists lambda get-function-url-config --function-name $lambdaName

    if ($urlExists) {
        $functionUrl = (Invoke-AwsCli lambda get-function-url-config --function-name $lambdaName --query "FunctionUrl" --output text | Out-String).Trim()
        Write-Host "  - 既存 Function URL を検出: $functionUrl" -ForegroundColor DarkGray
    } else {
        $functionUrl = (Invoke-AwsCli lambda create-function-url-config `
            --function-name $lambdaName `
            --auth-type "NONE" `
            --invoke-mode "BUFFERED" `
            --query "FunctionUrl" --output text | Out-String).Trim()
        Write-Host "  ✔ Function URL を新規発行しました" -ForegroundColor Green
    }

    # パブリックアクセス許可（リソースベースポリシー）
    $permExists = Test-AwsResourceExists lambda get-policy --function-name $lambdaName
    if (-not $permExists -or -not ((Invoke-AwsCli lambda get-policy --function-name $lambdaName | Out-String) -match "FunctionURLAllowPublicAccess")) {
        Invoke-AwsCli lambda add-permission `
            --function-name $lambdaName `
            --statement-id "FunctionURLAllowPublicAccess" `
            --action "lambda:InvokeFunctionUrl" `
            --principal "*" `
            --function-url-auth-type "NONE" | Out-Null
        Write-Host "  ✔ Function URL パブリックアクセス権限を付与しました" -ForegroundColor Green
    } else {
        Write-Host "  - パブリックアクセス権限は既に設定されています" -ForegroundColor DarkGray
    }

    Write-Host "`n==========================================================" -ForegroundColor Green
    Write-Host " プロビジョニングが正常に完了しました！" -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "`n【クライアント（作家様）提供案内】" -ForegroundColor Cyan
    Write-Host "----------------------------------------------------------"
    Write-Host "テナントID : $ClientId"
    Write-Host "専用URL    : $functionUrl"
    Write-Host "----------------------------------------------------------"
    Write-Host "※上記の専用URLは推測不能な秘密URL（Capability URL）です。"
    Write-Host "  他者へ公開せず、ブックマークしてご利用ください。"
    Write-Host ""
    Write-Host "【運用・セキュリティガイド（九龍工房内部用）】" -ForegroundColor Yellow
    Write-Host "- 万一URLが漏洩した場合の即時失効＆再発行コマンド:"
    Write-Host "  aws lambda delete-function-url-config --function-name $lambdaName"
    Write-Host "  aws lambda create-function-url-config --function-name $lambdaName --auth-type NONE"
    Write-Host "----------------------------------------------------------`n"
}
finally {
    # 一時ファイルの安全なクリーンアップ
    foreach ($f in $script:TempFiles) {
        if (Test-Path $f) {
            Remove-Item $f -Force -ErrorAction SilentlyContinue
        }
    }
}
