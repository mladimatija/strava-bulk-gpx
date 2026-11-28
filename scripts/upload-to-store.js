// Uploads a packaged zip to the Chrome Web Store as a new draft version,
// through the Chrome Web Store API (V2), and optionally submits it for
// review. Run by release.yml after the GitHub release is published:
//
//   node scripts/upload-to-store.js strava-bulk-gpx.zip
//
// Credentials come from the environment (see CONTRIBUTING.md, "Releases"):
//   CWS_SERVICE_ACCOUNT_KEY - the JSON key of a Google Cloud service account
//     that has been added to the publisher in the Developer Dashboard
//   CWS_PUBLISHER_ID - Developer Dashboard → Publisher → Settings
//   CWS_EXTENSION_ID - the item's 32-character id
//   CWS_AUTO_PUBLISH - "true" to also submit the upload for review
//
// A service account rather than an OAuth refresh token: it needs no consent
// screen, and nothing expires between releases.
//
// Uploading only replaces the draft package. The listing texts, screenshots
// and privacy answers still live in the dashboard, so a release that changes
// those is better published by hand - which is why submitting is opt-in.
//
// API reference: https://developer.chrome.com/docs/webstore/using-api
// Service accounts: https://developer.chrome.com/docs/webstore/service-accounts

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const API = 'https://chromewebstore.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

function env(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

/** Parse a response as JSON, failing with its status and body when it isn't a success. */
async function json(res, what) {
	const text = await res.text();
	if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} ${text}`);
	return text ? JSON.parse(text) : {};
}

const base64url = (value) => Buffer.from(value).toString('base64url');

/**
 * An access token for the service account: a JWT naming the account and the
 * scope, signed with the account's private key, exchanged at Google's token
 * endpoint. The token lasts an hour; one run needs it for a minute.
 */
async function accessToken() {
	let key;
	try {
		key = JSON.parse(env('CWS_SERVICE_ACCOUNT_KEY'));
	} catch {
		throw new Error('CWS_SERVICE_ACCOUNT_KEY is not the JSON key file of a service account');
	}
	if (!key.client_email || !key.private_key) {
		throw new Error('CWS_SERVICE_ACCOUNT_KEY has no client_email or private_key');
	}
	const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
	const now = Math.floor(Date.now() / 1000);
	const unsigned = [
		base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
		base64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 600 })),
	].join('.');
	const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
	const res = await fetch(tokenUri, {
		method: 'POST',
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion: `${unsigned}.${signature}`,
		}),
	});
	return (await json(res, 'Token exchange')).access_token;
}

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/upload-to-store.js <zip>');

const item = `publishers/${env('CWS_PUBLISHER_ID')}/items/${env('CWS_EXTENSION_ID')}`;
const headers = { Authorization: `Bearer ${await accessToken()}` };

const upload = await json(
	await fetch(`${API}/upload/v2/${item}:upload`, { method: 'POST', headers, body: await readFile(file) }),
	'Upload',
);
console.log('Upload:', JSON.stringify(upload));

// A large package is processed asynchronously; wait for it to settle.
let state = upload.uploadState;
for (let attempt = 0; state === 'IN_PROGRESS' && attempt < 30; attempt++) {
	await new Promise((resolve) => setTimeout(resolve, 5000));
	const status = await json(await fetch(`${API}/v2/${item}:fetchStatus`, { headers }), 'fetchStatus');
	state = status.lastAsyncUploadState ?? status.uploadState;
	console.log('Status:', JSON.stringify(status));
}
if (state && state !== 'SUCCEEDED') throw new Error(`Upload did not succeed: ${state}`);

if (process.env.CWS_AUTO_PUBLISH === 'true') {
	const published = await json(await fetch(`${API}/v2/${item}:publish`, { method: 'POST', headers }), 'Publish');
	console.log('Submitted for review:', JSON.stringify(published));
} else {
	console.log('Uploaded as a draft. Submit it for review in the Developer Dashboard.');
}
