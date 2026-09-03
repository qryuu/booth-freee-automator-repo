const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand } = require("@aws-sdk/client-secrets-manager");
const { parse } = require('csv-parse');

// 定数
const SECRET_NAME = process.env.SECRET_NAME;
const REGION = process.env.AWS_REGION || "ap-northeast-1";

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
 * Lambdaハンドラ
 */
exports.handler = async (event) => {
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
            const orderId = record['注文番号'];
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

        // 2. グループ化した注文ごとに処理を実行する
        for (const [orderId, orderDetails] of orders.entries()) {
            try {
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

            } catch (error) {
                console.error({
                    level: 'ERROR',
                    message: '注文の登録処理中に予期せぬエラーが発生しましたが、処理を続行します。',
                    error_details: error.message,
                    failed_order_id: orderId
                });
            }
        }
        
        return { statusCode: 200, body: JSON.stringify({ message: `Successfully processed orders from ${key}.` })};

     } catch (error) {
        console.error("An error occurred:", error);
        return { statusCode: 500, body: JSON.stringify({ message: 'Handler execution failed.', error: error.message })};
     }
};