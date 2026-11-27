// Uploads a packaged zip to the Chrome Web Store as a new draft version,
// through the Chrome Web Store API (V2), and optionally submits it for
// review. Run by release.yml after the GitHub release is published:
//
//   node scripts/upload-to-store.js strava-bulk-gpx.zip
//
// Credentials come from the environment (see CONTRIBUTING.md, "Releases"):
//   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN - an OAuth client and
//     a refresh token with the https://www.googleapis.com/auth/chromewebstore scope
//   CWS_PUBLISHER_ID - Developer Dashboard → Publisher → Settings
//   CWS_EXTENSION_ID - the item's 32-character id
//   CWS_AUTO_PUBLISH - "true" to also submit the upload for review
//
// Uploading only replaces the draft package. The listing texts, screenshots
// and privacy answers still live in the dashboard, so a release that changes
// those is better published by hand - which is why submitting is opt-in.
//
// API reference: https://developer.chrome.com/docs/webstore/using-api

import { readFile } from 'node:fs/promises';

const API = 'https://chromewebstore.googleapis.com';

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

async function accessToken() {
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		body: new URLSearchParams({
			client_id: env('CWS_CLIENT_ID'),
			client_secret: env('CWS_CLIENT_SECRET'),
			refresh_token: env('CWS_REFRESH_TOKEN'),
			grant_type: 'refresh_token',
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
