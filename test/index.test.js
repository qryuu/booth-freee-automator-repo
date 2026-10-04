const test = require('node:test');
const assert = require('node:assert/strict');
const { formatOrderDate, shiftDateString, fetchExistingOrderIds, postToFreee } = require('../index.js');

test('formatOrderDate: JSTの日付文字列から YYYY-MM-DD を抽出できる', () => {
    assert.equal(formatOrderDate('2026/10/01 12:34:56'), '2026-10-01');
    assert.equal(formatOrderDate('2026-10-02 00:00:00'), '2026-10-02');
    assert.equal(formatOrderDate('2026/5/3 09:10:00'), '2026-05-03');
    assert.equal(formatOrderDate(null), null);
    assert.equal(formatOrderDate(''), null);
});

test('shiftDateString: 月またぎ・年またぎを含め安全に日付を前後にシフトできる', () => {
    assert.equal(shiftDateString('2026-10-01', -1), '2026-09-30', '月初の前日は前月末日');
    assert.equal(shiftDateString('2026-10-31', 1), '2026-11-01', '月末の翌日は翌月初日');
    assert.equal(shiftDateString('2026-01-01', -1), '2025-12-31', '年始の前日は前年末日');
    assert.equal(shiftDateString('2026-12-31', 1), '2027-01-01', '年末の翌日は翌年初日');
    assert.equal(shiftDateString(null, 1), null);
});

test('fetchExistingOrderIds: 前後1日の安全バッファ付きURLでリクエストし、既存注文番号を抽出できる', async (t) => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });

    let requestedUrl = null;

    global.fetch = async (url) => {
        requestedUrl = url;
        return {
            ok: true,
            status: 200,
            json: async () => ({
                deals: [
                    {
                        id: 101,
                        ref_number: '12345678', // ref_number 付きの最新形式
                        details: [{ description: 'PixivBooth 注文番号: 12345678 (3Dモデル)' }]
                    },
                    {
                        id: 102,
                        ref_number: null, // ref_number なし（過去バージョン登録分）
                        details: [{ description: 'PixivBooth 注文番号: 87654321 (アバター衣装)' }]
                    },
                    {
                        id: 103,
                        ref_number: null,
                        details: [{ description: '別の取引メモ' }] // 対象外
                    }
                ]
            })
        };
    };

    // 2026-10-01 〜 2026-10-31 の範囲を指定
    const existingIds = await fetchExistingOrderIds('dummy-token', '12345', '2026-10-01', '2026-10-31');

    // 前後1日バッファが適用されていること（2026-09-30 〜 2026-11-01）
    assert.ok(requestedUrl.includes('start_issue_date=2026-09-30'), 'start_issue_date が前日(2026-09-30)にバッファされていること');
    assert.ok(requestedUrl.includes('end_issue_date=2026-11-01'), 'end_issue_date が翌日(2026-11-01)にバッファされていること');
    assert.ok(requestedUrl.includes('type=income'), '売上取引に絞り込まれていること');

    assert.equal(existingIds.size, 2);
    assert.ok(existingIds.has('12345678'), 'ref_number から抽出できること');
    assert.ok(existingIds.has('87654321'), 'description のフォールバックから抽出できること');
    assert.ok(!existingIds.has('99999999'), '存在しない注文番号は含まれないこと');
});

test('fetchExistingOrderIds: freee APIエラー時は例外を投げて安全に処理を中断する（フェイルセーフ）', async (t) => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });

    global.fetch = async () => ({
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests'
    });

    await assert.rejects(
        async () => {
            await fetchExistingOrderIds('dummy-token', '12345', '2026-10-01', '2026-10-31');
        },
        /Failed to fetch existing deals from freee/,
        'APIエラー時に二重登録を防ぐため例外がスローされること'
    );
});

test('postToFreee: 取引作成ペイロードに ref_number が含まれる', async (t) => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });

    let capturedPayload = null;

    global.fetch = async (url, options) => {
        capturedPayload = JSON.parse(options.body);
        return {
            ok: true,
            status: 201,
            json: async () => ({ deal: { id: 999 } })
        };
    };

    const dummyOrder = {
        orderId: '55443322',
        date: '2026-10-01',
        totalAmount: 5000,
        fee: 500,
        description: 'PixivBooth 注文番号: 55443322 (アバターA)'
    };

    const dummySecrets = {
        FREEE_COMPANY_ID: '12345',
        FREEE_WALLETABLE_ID: '67890'
    };

    const dummyIds = {
        itemIdUriage: 11,
        itemIdTesuryo: 22,
        taxCodeUriage: 33,
        taxCodeShiire: 44,
        partnerId: 55,
        itemIdUriageItem: null,
        itemIdTesuryoItem: null
    };

    await postToFreee(dummyOrder, 'dummy-token', dummySecrets, dummyIds);

    assert.ok(capturedPayload, 'ペイロードが送信されること');
    assert.equal(capturedPayload.ref_number, '55443322', 'ref_number に注文番号が設定されていること');
    assert.equal(capturedPayload.issue_date, '2026-10-01');
    assert.equal(capturedPayload.details[0].amount, 5000);
    assert.equal(capturedPayload.details[1].amount, -500);
});
