const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand } = require("@aws-sdk/client-secrets-manager");
const { parse } = require('csv-parse');

// 定数
const SECRET_NAME = process.env.SECRET_NAME;
const REGION = process.env.AWS_REGION || "ap-northeast-1";
const UPLOAD_BUCKET_NAME = process.env.UPLOAD_BUCKET_NAME || "booth-freee-csv-upload-chocotip";

// オプショナル設定: 環境変数（またはSecrets Manager）から取得
const PARTNER_NAME = process.env.PARTNER_NAME;
const ITEM_NAME_URIAGE = process.env.ITEM_NAME_URIAGE;
const ITEM_NAME_TESURYO = process.env.ITEM_NAME_TESURYO;

const s3Client = new S3Client({ region: REGION });
const secretsClient = new SecretsManagerClient({ region: REGION });

/**
 * 注文日時から 'YYYY-MM-DD' を安全に抽出（JSTのタイムゾーンズレ防止）
 */
function formatOrderDate(dateString) {
    if (!dateString) return null;
    const match = dateString.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (match) {
        const year = match[1];
        const month = match[2].padStart(2, '0');
        const day = match[3].padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('sv-SE');
}

/**
 * 'YYYY-MM-DD' 文字列の日付を前後にシフト（UTC基準でタイムゾーンズレを防止）
 */
function shiftDateString(dateString, days) {
    if (!dateString) return null;
    const parts = dateString.split('-').map(Number);
    if (parts.length !== 3 || isNaN(parts[0]) || isNaN(parts[1]) || isNaN(parts[2])) return null;
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
    return d.toISOString().slice(0, 10);
}

/**
 * Secrets Managerから機密情報を取得
 */
async function getSecrets() {
    const command = new GetSecretValueCommand({ SecretId: SECRET_NAME });
    const data = await secretsClient.send(command);
    return JSON.parse(data.SecretString);
}

/**
 * 新しいアクセストークンを取得し、リフレッシュトークンを更新
 */
async function refreshAccessToken(secrets) {
    console.log("Refreshing freee access token...");
    const url = "https://accounts.secure.freee.co.jp/public_api/token";
    const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: secrets.FREEE_CLIENT_ID,
        client_secret: secrets.FREEE_CLIENT_SECRET,
        refresh_token: secrets.FREEE_REFRESH_TOKEN,
    });

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });

    if (!response.ok) {
        throw new Error(`Failed to refresh token: ${response.status} ${await response.text()}`);
    }

    const tokenData = await response.json();
    console.log("Successfully refreshed access token.");

    const newSecrets = { ...secrets, FREEE_REFRESH_TOKEN: tokenData.refresh_token };
    const updateCommand = new UpdateSecretCommand({
        SecretId: SECRET_NAME,
        SecretString: JSON.stringify(newSecrets),
    });
    await secretsClient.send(updateCommand);
    console.log("Successfully updated the refresh token in Secrets Manager.");

    return tokenData.access_token;
}

/**
 * freee APIから勘定科目、税区分、取引先、品目のIDを自動取得
 */
async function getFreeeIds(accessToken, companyId, options = {}) {
    console.log("Fetching account items and tax codes from freee...");
    const headers = { "Authorization": `Bearer ${accessToken}` };

    // 勘定科目を取得
    const itemsRes = await fetch(`https://api.freee.co.jp/api/1/account_items?company_id=${companyId}`, { headers });
    if (!itemsRes.ok) throw new Error("Failed to fetch account items.");
    const { account_items } = await itemsRes.json();
    
    const uriageItem = account_items.find(item => item.name === "売上高");
    const tesuryoItem = account_items.find(item => item.name === "支払手数料");
    if (!uriageItem || !tesuryoItem) {
        throw new Error("Could not find required account items: '売上高' or '支払手数料'");
    }

    // 税区分を取得
    const taxesRes = await fetch(`https://api.freee.co.jp/api/1/taxes/codes?company_id=${companyId}`, { headers });
    if (!taxesRes.ok) throw new Error("Failed to fetch tax codes.");
    const { taxes } = await taxesRes.json();
    
    // 検索対象のキーを 'name_ja' に設定
    const uriageTax = taxes.find(tax => tax.name_ja === "課税売上10%");
    const shiireTax = taxes.find(tax => tax.name_ja === "課対仕入10%");
    if (!uriageTax || !shiireTax) {
        throw new Error("Could not find required tax codes: '課税売上10%' or '課対仕入10%'");
    }

    // 取引先IDの解決（オプショナル設定）
    let partnerId = null;
    if (options.partnerName) {
        console.log(`Searching for partner: "${options.partnerName}"...`);
        const partnerRes = await fetch(
            `https://api.freee.co.jp/api/1/partners?company_id=${companyId}&keyword=${encodeURIComponent(options.partnerName)}`,
            { headers }
        );
        if (!partnerRes.ok) {
            throw new Error(`Failed to fetch partners: ${partnerRes.status} ${await partnerRes.text()}`);
        }
        const { partners } = await partnerRes.json();
        const foundPartner = partners.find(p => p.name === options.partnerName || p.display_name === options.partnerName);
        if (!foundPartner) {
            throw new Error(`Partner '${options.partnerName}' was specified, but could not be found in freee.`);
        }
        partnerId = foundPartner.id;
        console.log(`Found partner ID: ${partnerId} for "${options.partnerName}"`);
    }

    // 品目IDの解決（オプショナル設定）
    let itemIdUriageItem = null;
    let itemIdTesuryoItem = null;
    if (options.itemNameUriage || options.itemNameTesuryo) {
        console.log("Fetching items from freee...");
        const freeeItemsRes = await fetch(`https://api.freee.co.jp/api/1/items?company_id=${companyId}`, { headers });
        if (!freeeItemsRes.ok) {
            throw new Error(`Failed to fetch items: ${freeeItemsRes.status} ${await freeeItemsRes.text()}`);
        }
        const { items } = await freeeItemsRes.json();

        if (options.itemNameUriage) {
            const foundItem = items.find(item => item.name === options.itemNameUriage);
            if (!foundItem) {
                throw new Error(`Item '${options.itemNameUriage}' was specified for sales, but could not be found in freee.`);
            }
            itemIdUriageItem = foundItem.id;
            console.log(`Found sales item ID: ${itemIdUriageItem} for "${options.itemNameUriage}"`);
        }

        if (options.itemNameTesuryo) {
            const foundItem = items.find(item => item.name === options.itemNameTesuryo);
            if (!foundItem) {
                throw new Error(`Item '${options.itemNameTesuryo}' was specified for fees, but could not be found in freee.`);
            }
            itemIdTesuryoItem = foundItem.id;
            console.log(`Found fee item ID: ${itemIdTesuryoItem} for "${options.itemNameTesuryo}"`);
        }
    }

    const ids = {
        itemIdUriage: uriageItem.id,
        itemIdTesuryo: tesuryoItem.id,
        taxCodeUriage: uriageTax.code,
        taxCodeShiire: shiireTax.code,
        partnerId,
        itemIdUriageItem,
        itemIdTesuryoItem,
    };
    console.log("Successfully fetched all required IDs:", ids);
    return ids;
}


/**
 * freee APIに取引を登録
 */
async function postToFreee(order, accessToken, secrets, ids) {
    const url = "https://api.freee.co.jp/api/1/deals";
    const details = [
        {
            account_item_id: ids.itemIdUriage,
            tax_code: ids.taxCodeUriage,
            amount: order.totalAmount,
            description: order.description,
            ...(ids.itemIdUriageItem ? { item_id: ids.itemIdUriageItem } : {})
        },
        {
            account_item_id: ids.itemIdTesuryo,
            tax_code: ids.taxCodeShiire,
            amount: -order.fee,
            ...(ids.itemIdTesuryoItem ? { item_id: ids.itemIdTesuryoItem } : {})
        }
    ];

    const payload = {
        issue_date: order.date,
        type: "income",
        company_id: parseInt(secrets.FREEE_COMPANY_ID, 10),
        ...(ids.partnerId ? { partner_id: ids.partnerId } : {}),
        ref_number: String(order.orderId),
        details: details,
        payments: [{
            date: order.date,
            from_walletable_type: "wallet",
            from_walletable_id: parseInt(secrets.FREEE_WALLETABLE_ID, 10),
            amount: order.totalAmount - order.fee
        }]
    };

    console.log(`Posting order ${order.orderId} to freee...`);
    const response = await fetch(url, {
        method: 'POST',
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}`, "X-Api-Version": "2020-06-15" },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`freee API Error: ${response.status} ${await response.text()}`);
    }
    const responseData = await response.json();
    console.log(`Successfully posted order ${order.orderId}. Deal ID: ${responseData.deal.id}`);
}

/**
 * 対象期間内の既存取引をfreeeから取得し、登録済みの注文番号一覧（Set）を生成（二重登録防止）
 * 過去バージョンのUTCズレ等も考慮し、前後1日の安全バッファを適用して取得
 */
async function fetchExistingOrderIds(accessToken, companyId, minDate, maxDate) {
    if (!minDate || !maxDate) return new Set();

    // 前後1日の安全バッファを適用（UTCズレ等による日付相違も確実に検知）
    const bufferedMinDate = shiftDateString(minDate, -1);
    const bufferedMaxDate = shiftDateString(maxDate, 1);

    console.log(`Fetching existing deals between ${bufferedMinDate} and ${bufferedMaxDate} (buffered from ${minDate}~${maxDate}) to prevent duplicates...`);

    const existingOrderIds = new Set();
    const headers = {
        "Authorization": `Bearer ${accessToken}`,
        "X-Api-Version": "2020-06-15"
    };
    const limit = 100;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        const url = `https://api.freee.co.jp/api/1/deals?company_id=${companyId}&type=income&start_issue_date=${bufferedMinDate}&end_issue_date=${bufferedMaxDate}&limit=${limit}&offset=${offset}`;
        const response = await fetch(url, { headers });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch existing deals from freee (${response.status}: ${errorText}). Duplicate check aborted to prevent accidental double-registration.`);
        }

        const data = await response.json();
        const deals = data.deals || [];
        if (deals.length === 0) {
            break;
        }

        for (const deal of deals) {
            // 1. ref_number に保存されている注文番号をチェック
            if (deal.ref_number) {
                existingOrderIds.add(String(deal.ref_number).trim());
            }
            // 2. 過去バージョンで登録された description 内の注文番号（フォールバック）をチェック
            if (deal.details && Array.isArray(deal.details)) {
                for (const d of deal.details) {
                    if (d.description) {
                        const match = d.description.match(/注文番号[:：]?\s*([A-Za-z0-9_-]+)/);
                        if (match && match[1]) {
                            existingOrderIds.add(match[1].trim());
                        }
                    }
                }
            }
        }

        if (deals.length < limit) {
            hasMore = false;
        } else {
            offset += limit;
        }
    }

    console.log(`Found ${existingOrderIds.size} existing orders in freee for duplicate check.`);
    return existingOrderIds;
}

/**
 * S3からCSVを解析
 */
async function parseCsvFromS3(bucket, key) {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const { Body } = await s3Client.send(command);
    const records = [];
    // BOM付きCSVにも対応
    const parser = Body.pipe(parse({ columns: true, bom: true }));
    for await (const record of parser) {
        records.push(record);
    }
    return records;
}

/**
 * Function URL用のHTMLアップロード画面
 */
function renderUploadHtml() {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BOOTH売上データ アップロード | 九龍工房</title>
    <style>
        :root {
            --primary: #2563eb;
            --primary-hover: #1d4ed8;
            --bg: #f8fafc;
            --card-bg: #ffffff;
            --text-main: #0f172a;
            --text-sub: #475569;
            --border: #cbd5e1;
            --success-bg: #ecfdf5;
            --success-border: #10b981;
            --success-text: #065f46;
            --error-bg: #fef2f2;
            --error-border: #ef4444;
            --error-text: #991b1b;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background-color: var(--bg); color: var(--text-main); display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 24px; }
        .card { background: var(--card-bg); max-width: 560px; width: 100%; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05); padding: 32px; border: 1px solid #e2e8f0; }
        .header { text-align: center; margin-bottom: 24px; }
        .badge { display: inline-block; background: #dbeafe; color: #1e40af; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 9999px; margin-bottom: 8px; }
        h1 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
        .subtitle { font-size: 13px; color: var(--text-sub); }
        .dropzone { border: 2px dashed var(--border); border-radius: 12px; padding: 36px 20px; text-align: center; background: #fafafa; cursor: pointer; transition: all 0.2s; }
        .dropzone.dragover { border-color: var(--primary); background: #eff6ff; }
        .dropzone-icon { font-size: 36px; margin-bottom: 8px; display: block; }
        .dropzone-text { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
        .dropzone-sub { font-size: 12px; color: var(--text-sub); }
        #fileInput { display: none; }
        .file-preview { display: none; margin-top: 16px; padding: 12px 16px; background: #f1f5f9; border-radius: 8px; align-items: center; justify-content: space-between; }
        .file-info { display: flex; align-items: center; gap: 10px; }
        .file-name { font-size: 14px; font-weight: 600; }
        .file-size { font-size: 12px; color: var(--text-sub); }
        .btn-remove { background: none; border: none; color: #ef4444; cursor: pointer; font-size: 18px; padding: 4px; }
        .btn-upload { width: 100%; margin-top: 20px; padding: 14px; background-color: var(--primary); color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; }
        .btn-upload:hover:not(:disabled) { background-color: var(--primary-hover); }
        .btn-upload:disabled { background-color: #94a3b8; cursor: not-allowed; }
        .result-box { display: none; margin-top: 20px; padding: 16px; border-radius: 8px; font-size: 13px; line-height: 1.5; }
        .result-box.success { background: var(--success-bg); border: 1px solid var(--success-border); color: var(--success-text); }
        .result-box.error { background: var(--error-bg); border: 1px solid var(--error-border); color: var(--error-text); }
        .spinner { width: 16px; height: 16px; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; display: none; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .help-note { margin-top: 20px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 11px; color: var(--text-sub); line-height: 1.6; }
    </style>
</head>
<body>
<div class="card">
    <div class="header">
        <span class="badge">九龍工房 会計自動化ポータル</span>
        <h1>BOOTH売上データ アップロード</h1>
        <p class="subtitle">ダウンロードした売上CSVを投入するとfreeeに自動記帳されます</p>
    </div>
    <div class="dropzone" id="dropzone">
        <span class="dropzone-icon">📥</span>
        <div class="dropzone-text">ここに売上CSVをドラッグ＆ドロップ</div>
        <div class="dropzone-sub">またはクリックしてファイルを選択 (.csv)</div>
        <input type="file" id="fileInput" accept=".csv,text/csv">
    </div>
    <div class="file-preview" id="filePreview">
        <div class="file-info">
            <span>📄</span>
            <div>
                <div class="file-name" id="fileName">Orders.csv</div>
                <div class="file-size" id="fileSize">0 KB</div>
            </div>
        </div>
        <button class="btn-remove" id="btnRemove" title="選択解除">✕</button>
    </div>
    <button class="btn-upload" id="btnUpload" disabled>
        <span class="spinner" id="spinner"></span>
        <span id="btnText">freeeに自動記帳を開始する</span>
    </button>
    <div class="result-box" id="resultBox"></div>
    <div class="help-note">
        <strong>💡 安心のセルフサービス設計:</strong><br>
        すでにfreeeに登録済みの注文は自動検知して安全にスキップされます（二重計上防止）。<br>
        アップロード後、数十秒でfreeeの「BOOTH」口座に取引が反映されます。
    </div>
</div>
<script>
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('fileInput');
    const filePreview = document.getElementById('filePreview');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');
    const btnRemove = document.getElementById('btnRemove');
    const btnUpload = document.getElementById('btnUpload');
    const btnText = document.getElementById('btnText');
    const spinner = document.getElementById('spinner');
    const resultBox = document.getElementById('resultBox');

    let selectedFile = null;

    ['dragenter', 'dragover'].forEach(name => {
        dropzone.addEventListener(name, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(name => {
        dropzone.addEventListener(name, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); });
    });
    dropzone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) handleFile(files[0]);
    });
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFile(e.target.files[0]);
    });

    function handleFile(file) {
        if (!file.name.toLowerCase().endsWith('.csv')) {
            showResult('error', 'CSV形式のファイル（.csv）を選択してください。');
            return;
        }
        selectedFile = file;
        fileName.textContent = file.name;
        fileSize.textContent = (file.size / 1024).toFixed(1) + ' KB';
        filePreview.style.display = 'flex';
        btnUpload.disabled = false;
        hideResult();
    }

    btnRemove.addEventListener('click', () => {
        selectedFile = null;
        fileInput.value = '';
        filePreview.style.display = 'none';
        btnUpload.disabled = true;
        hideResult();
    });

    btnUpload.addEventListener('click', async () => {
        if (!selectedFile) return;
        setLoading(true);
        hideResult();
        try {
            const response = await fetch(window.location.href, {
                method: 'POST',
                headers: { 'Content-Type': 'text/csv' },
                body: selectedFile
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || 'アップロードに失敗しました。');
            showResult('success', '<strong>🎉 アップロード完了！</strong><br>' + data.message + '<br><small>数十秒後にfreeeの「BOOTH」口座をご確認ください。</small>');
            selectedFile = null;
            filePreview.style.display = 'none';
            btnUpload.disabled = true;
        } catch (err) {
            showResult('error', '<strong>⚠️ エラー:</strong> ' + err.message);
        } finally {
            setLoading(false);
        }
    });

    function setLoading(isLoading) {
        btnUpload.disabled = isLoading;
        spinner.style.display = isLoading ? 'inline-block' : 'none';
        btnText.textContent = isLoading ? 'アップロード処理中...' : 'freeeに自動記帳を開始する';
    }
    function showResult(type, html) {
        resultBox.className = 'result-box ' + type;
        resultBox.innerHTML = html;
        resultBox.style.display = 'block';
    }
    function hideResult() { resultBox.style.display = 'none'; }
</script>
</body>
</html>`;
}

/**
 * Function URL (HTTP) リクエストの処理
 */
async function handleHttpRequest(event) {
    const method = event.requestContext?.http?.method || 'GET';

    if (method === 'GET') {
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            },
            body: renderUploadHtml()
        };
    }

    if (method === 'POST') {
        try {
            let csvBuffer;
            if (event.isBase64Encoded) {
                csvBuffer = Buffer.from(event.body, 'base64');
            } else {
                csvBuffer = Buffer.from(event.body || '', 'utf-8');
            }

            if (!csvBuffer || csvBuffer.length === 0) {
                return {
                    statusCode: 400,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ success: false, message: 'CSVデータが空です。' })
                };
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const key = `Orders_${timestamp}.csv`;

            const putCmd = new PutObjectCommand({
                Bucket: UPLOAD_BUCKET_NAME,
                Key: key,
                Body: csvBuffer,
                ContentType: 'text/csv'
            });

            await s3Client.send(putCmd);
            console.log(`Successfully uploaded ${key} to ${UPLOAD_BUCKET_NAME}`);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    key: key,
                    bucket: UPLOAD_BUCKET_NAME,
                    message: `ファイル (${key}) がS3に正常に保存されました。間もなくfreeeへの自動記帳が実行されます。`
                })
            };
        } catch (error) {
            console.error('Error handling CSV upload:', error);
            return {
                statusCode: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: false,
                    message: `アップロード処理中にエラーが発生しました: ${error.message}`
                })
            };
        }
    }

    return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Method Not Allowed' })
    };
}

/**
 * Lambdaハンドラ
 */
exports.handler = async (event) => {
    // Function URL / HTTP リクエストの処理
    if (event.requestContext?.http) {
        return await handleHttpRequest(event);
    }

    try {
        const secrets = await getSecrets();
        const accessToken = await refreshAccessToken(secrets);

        // 取引先名・品目名（環境変数優先、Secrets Managerフォールバック）
        const partnerName = PARTNER_NAME || secrets.PARTNER_NAME || null;
        const itemNameUriage = ITEM_NAME_URIAGE || secrets.ITEM_NAME_URIAGE || null;
        const itemNameTesuryo = ITEM_NAME_TESURYO || secrets.ITEM_NAME_TESURYO || null;

        const freeeIds = await getFreeeIds(accessToken, secrets.FREEE_COMPANY_ID, {
            partnerName,
            itemNameUriage,
            itemNameTesuryo,
        });

        const bucket = event.Records[0].s3.bucket.name;
        const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));

        const records = await parseCsvFromS3(bucket, key);
        console.log(`Parsed ${records.length} records from CSV.`);

        // 1. CSVのレコードを「注文番号」でグループ化する
        const orders = new Map();
        for (const record of records) {
            const orderId = String(record['注文番号'] || '').trim();
            if (!orderId) {
                console.warn('注文番号がないため、この行をスキップします:', record);
                continue;
            }

            if (!orders.has(orderId)) {
                // ★ 改善箇所: 最新の「サービス利用料」を最優先し、過去の名称もカバー
                const feeString = 
                    record['サービス利用料'] || 
                    record['手数料'] || 
                    record['サービス利用料・倉庫発送手数料'] || 
                    '0';
                
                // もし全ての候補が見つからない場合はログに警告を出す（デバッグ用）
                if (!record['サービス利用料'] && !record['手数料'] && !record['サービス利用料・倉庫発送手数料']) {
                    console.warn(`[INFO] 注文 ${orderId}: 手数料関連の項目が見つかりませんでした。0円として処理します。`);
                }
                
                orders.set(orderId, {
                    items: [],
                    orderDate: record['注文日時'] || null,
                    totalFee: Math.abs(parseInt(feeString.replace(/,/g, ''), 10)),
                });
            }

            const currentOrder = orders.get(orderId);
            currentOrder.items.push({
                name: record['商品名'],
                variation: record['バリエーション名'],
                subtotal: parseInt(record['小計']?.replace(/,/g, '') || '0', 10),
            });

            // 2行目以降で日付が空の場合、同じ注文の最初の行の日付を引き継ぐ
            if (!currentOrder.orderDate && record['注文日時']) {
                currentOrder.orderDate = record['注文日時'];
            }
        }

        // 2. 有効な注文の日付範囲を特定し、既存取引を事前取得（二重登録防止）
        const validDates = [];
        for (const orderDetails of orders.values()) {
            const formattedDate = formatOrderDate(orderDetails.orderDate);
            if (formattedDate) {
                validDates.push(formattedDate);
            }
        }

        let existingOrderIds = new Set();
        if (validDates.length > 0) {
            validDates.sort();
            const minDate = validDates[0];
            const maxDate = validDates[validDates.length - 1];
            // 既存取引の取得に失敗した場合は安全のため中断（フェイルセーフ: 二重登録を完全防止）
            existingOrderIds = await fetchExistingOrderIds(accessToken, secrets.FREEE_COMPANY_ID, minDate, maxDate);
        }

        const registeredOrderIds = [];
        const skippedOrderIds = [];

        // 3. グループ化した注文ごとに処理を実行する
        for (const [orderId, orderDetails] of orders.entries()) {
            try {
                // 二重登録防止ガード: 既にfreeeに存在する注文番号はスキップ
                if (existingOrderIds.has(orderId)) {
                    console.log(`[DUPLICATE_SKIP] 注文番号: ${orderId} は既にfreeeに登録済みのためスキップします。`);
                    skippedOrderIds.push(orderId);
                    continue;
                }

                // 注文全体の日付を検証 & JSTベースでYYYY-MM-DDを生成（タイムゾーンズレ防止）
                const formattedDate = formatOrderDate(orderDetails.orderDate);
                if (!formattedDate) {
                    console.warn({
                        level: 'WARN',
                        message: '[手動登録推奨] 注文日時が不正なため、この注文全体の登録をスキップしました。',
                        orderId: orderId,
                        skipped_order: orderDetails
                    });
                    continue;
                }
                
                // 注文に含まれる全商品の小計を合算する
                const totalAmount = orderDetails.items.reduce((sum, item) => sum + item.subtotal, 0);

                if (totalAmount === 0) continue;
                
                // freeeの摘要欄に記載する全商品名を生成
                const description = `PixivBooth 注文番号: ${orderId} (${orderDetails.items.map(item => `${item.name}(${item.variation || 'default'})`).join(', ')})`;

                // freeeに送信するデータを作成
                const orderData = {
                    orderId: orderId,
                    date: formattedDate,
                    totalAmount: totalAmount,
                    fee: orderDetails.totalFee,
                    description: description
                };

                await postToFreee(orderData, accessToken, secrets, freeeIds);
                existingOrderIds.add(orderId);
                registeredOrderIds.push(orderId);

            } catch (error) {
                console.error({
                    level: 'ERROR',
                    message: '注文の登録処理中に予期せぬエラーが発生しましたが、処理を続行します。',
                    error_details: error.message,
                    failed_order_id: orderId
                });
            }
        }
        
        const summary = {
            message: `Successfully processed CSV: ${key}`,
            totalOrdersInCsv: orders.size,
            registeredCount: registeredOrderIds.length,
            skippedCount: skippedOrderIds.length,
            registeredOrderIds,
            skippedOrderIds,
        };
        console.log("=== Execution Summary ===", JSON.stringify(summary, null, 2));

        return { statusCode: 200, body: JSON.stringify(summary) };

     } catch (error) {
        console.error("An error occurred:", error);
        return { statusCode: 500, body: JSON.stringify({ message: 'Handler execution failed.', error: error.message })};
     }
};

// テストおよび外部利用のためのエクスポート
module.exports = {
    handler: exports.handler,
    formatOrderDate,
    shiftDateString,
    fetchExistingOrderIds,
    postToFreee,
    getFreeeIds,
    parseCsvFromS3,
    renderUploadHtml,
    handleHttpRequest,
};