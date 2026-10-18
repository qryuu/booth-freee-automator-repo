const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isWindows = process.platform === 'win32';

test('provision-client.ps1: ファイルが存在し、UTF-8 BOM付きで保存されている', () => {
    const scriptPath = path.resolve(__dirname, '../tools/provision-client.ps1');
    assert.ok(fs.existsSync(scriptPath), 'provision-client.ps1 が存在すること');
    
    const buffer = fs.readFileSync(scriptPath);
    // UTF-8 BOM: 0xEF, 0xBB, 0xBF
    assert.equal(buffer[0], 0xEF, 'BOM byte 1');
    assert.equal(buffer[1], 0xBB, 'BOM byte 2');
    assert.equal(buffer[2], 0xBF, 'BOM byte 3');
});

test('provision-client.ps1: AST構文エラーがないこと (Windows only)', { skip: !isWindows }, () => {
    const scriptPath = path.resolve(__dirname, '../tools/provision-client.ps1').replace(/\\/g, '/');
    const cmd = `powershell -NoProfile -Command "$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath}', [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { exit 1 } else { exit 0 }"`;
    assert.doesNotThrow(() => {
        execSync(cmd, { stdio: 'pipe' });
    });
});

test('provision-client.ps1: -DryRun オプションが正常終了し、計画を出力すること (Windows only)', { skip: !isWindows }, () => {
    const scriptPath = path.resolve(__dirname, '../tools/provision-client.ps1').replace(/\\/g, '/');
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -ClientId test-c01 -FreeeClientId dummy -FreeeClientSecret dummy -FreeeRefreshToken dummy -FreeeCompanyId 123 -FreeeWalletableId 456 -DryRun`;
    const output = execSync(cmd, { encoding: 'utf-8' });
    assert.ok(output.includes('booth-freee-csv-upload-test-c01'));
    assert.ok(output.includes('booth-freee-automator/credentials-test-c01'));
    assert.ok(output.includes('booth-freee-automator-role-test-c01'));
    assert.ok(output.includes('DRY-RUN'));
});

test('provision-client.ps1: 不正な ClientId（大文字・末尾ハイフン等）はバリデーションエラーになること (Windows only)', { skip: !isWindows }, () => {
    const scriptPath = path.resolve(__dirname, '../tools/provision-client.ps1').replace(/\\/g, '/');
    const invalidIds = ['Author-001', 'author-', 'ab', 'author_01', '-author'];
    
    for (const badId of invalidIds) {
        const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -ClientId "${badId}" -FreeeClientId dummy -FreeeClientSecret dummy -FreeeRefreshToken dummy -FreeeCompanyId 123 -FreeeWalletableId 456 -DryRun`;
        assert.throws(() => {
            execSync(cmd, { stdio: 'pipe' });
        }, `ClientId "${badId}" should be rejected`);
    }
});

test('provision-client.ps1: New-TempJsonFile が BOMなしUTF-8 (UTF8Encoding(false)) を使用していること', () => {
    const scriptPath = path.resolve(__dirname, '../tools/provision-client.ps1');
    const content = fs.readFileSync(scriptPath, 'utf-8');
    assert.ok(content.includes('System.Text.UTF8Encoding($false)'), 'UTF8Encoding($false) が使用されていること');
    assert.ok(!content.includes('[System.Text.Encoding]::UTF8)'), 'デフォルトのBOM付きUTF8でファイルを直接書き出していないこと');
    assert.ok(content.includes("AWS_CLI_FILE_ENCODING = 'UTF-8'"), 'AWS_CLI_FILE_ENCODING が UTF-8 に設定されていること');
});
