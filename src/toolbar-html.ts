// The toolbar's markup. Elements are found again by their `data-role`
// (see content.ts), which wires up the behaviour.

import { t } from './i18n.ts';
import { KOFI_IMAGE } from './kofi-asset.ts';
import { radiusLabel, sizeLabel, SPLIT_SIZES_MB, TRIM_RADII } from './state.ts';
import { unitName } from './units.ts';

const KOFI_URL = 'https://ko-fi.com/D1D51ZGOQK';

/**
 * Escape user-supplied text before embedding it in an innerHTML template.
 * Translated strings come from Chrome's i18n system, which we control, but
 * being defensive keeps a future "wrong message file" pasted by a contributor
 * from breaking out of the attribute it lives in.
 */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** The toolbar's inner HTML, in the browser's language. */
export function toolbarHtml(): string {
	const koFiLabel = escapeHtml(t('koFiTitle'));
	return `
      <label class="sbgx-tool sbgx-select-all">
        <input type="checkbox" class="sbgx-select-all-cb" />
        <span>${escapeHtml(t('selectAllVisible'))}</span>
      </label>
      <button class="sbgx-btn sbgx-btn-link" data-role="select-new">${escapeHtml(t('selectNew'))}</button>
      <button class="sbgx-btn sbgx-btn-link" data-role="select-pages" title="${escapeHtml(t('selectAllPagesTitle'))}">${escapeHtml(t('selectAllPages'))}</button>
      <button class="sbgx-btn sbgx-btn-link" data-role="select-new-pages">${escapeHtml(t('selectNewAllPages'))}</button>
      <label class="sbgx-tool sbgx-format-wrap">
        <span>${escapeHtml(t('formatLabel'))}</span>
        <select class="sbgx-format" data-role="format">
          <option value="gpx">${escapeHtml(t('gpxButton'))}</option>
          <option value="tcx">${escapeHtml(t('formatTcx'))}</option>
          <option value="original">${escapeHtml(t('formatOriginal'))}</option>
        </select>
      </label>
      <label class="sbgx-tool sbgx-format-wrap" title="${escapeHtml(t('namesTooltip'))}">
        <span>${escapeHtml(t('namesLabel'))}</span>
        <select class="sbgx-format" data-role="names">
          <option value="id">${escapeHtml(t('namesId'))}</option>
          <option value="title">${escapeHtml(t('namesTitle'))}</option>
          <option value="sport">${escapeHtml(t('namesSport'))}</option>
          <option value="date">${escapeHtml(t('namesDate'))}</option>
        </select>
      </label>
      <button class="sbgx-btn sbgx-btn-primary" data-role="bulk" disabled>${escapeHtml(t('downloadSelected'))}</button>
      <button class="sbgx-btn sbgx-btn-secondary" data-role="merge" disabled>${escapeHtml(t('mergeSelected'))}</button>
      <button class="sbgx-btn" data-role="csv" disabled>${escapeHtml(t('exportCsv'))}</button>
      <details class="sbgx-more" data-role="more">
        <summary class="sbgx-btn" title="${escapeHtml(t('moreOptions'))}">⋯</summary>
        <div class="sbgx-menu">
          <label class="sbgx-menu-field">
            <span class="sbgx-menu-heading">${escapeHtml(t('mergeModeLabel'))}</span>
            <select class="sbgx-format" data-role="merge-mode">
              <option value="tracks">${escapeHtml(t('mergeModeTracks'))}</option>
              <option value="single">${escapeHtml(t('mergeModeSingle'))}</option>
              <option value="geojson">${escapeHtml(t('mergeModeGeojson'))}</option>
            </select>
          </label>
          <label class="sbgx-menu-field" title="${escapeHtml(t('trimTitle'))}">
            <span class="sbgx-menu-heading">${escapeHtml(t('trimLabel'))}</span>
            <select class="sbgx-format" data-role="trim">
              <option value="0">${escapeHtml(t('trimOff'))}</option>
              ${TRIM_RADII.map((r) => `<option value="${r}">${radiusLabel(r)}</option>`).join('')}
              <option value="custom">${escapeHtml(t('trimCustom'))}</option>
            </select>
          </label>
          <div class="sbgx-trim-custom" data-role="trim-custom" hidden>
            <input type="number" class="sbgx-format" min="1" step="any" data-role="trim-value" aria-label="${escapeHtml(t('trimCustomValue'))}" placeholder="${escapeHtml(t('trimCustomValue'))}" />
            <select class="sbgx-format" data-role="trim-unit" aria-label="${escapeHtml(t('trimCustomUnit'))}">
              <option value="m">${escapeHtml(unitName('m', navigator.language))}</option>
              <option value="ft">${escapeHtml(unitName('ft', navigator.language))}</option>
            </select>
          </div>
          <label class="sbgx-menu-field" title="${escapeHtml(t('splitTitle'))}">
            <span class="sbgx-menu-heading">${escapeHtml(t('splitLabel'))}</span>
            <select class="sbgx-format" data-role="split">
              ${SPLIT_SIZES_MB.map((mb) => `<option value="${mb}">${mb > 0 ? sizeLabel(mb) : escapeHtml(t('splitNever'))}</option>`).join('')}
            </select>
          </label>
          <span class="sbgx-menu-heading" data-role="folder-heading">${escapeHtml(t('folderHeading'))}</span>
          <button class="sbgx-btn" data-role="folder" title="${escapeHtml(t('saveToFolderTitle'))}" disabled>${escapeHtml(t('saveToFolder'))}</button>
          <span class="sbgx-menu-heading">${escapeHtml(t('historyHeading'))}</span>
          <button class="sbgx-btn" data-role="history-import"></button>
          <input type="file" accept=".csv,text/csv" data-role="history-file" hidden />
          <button class="sbgx-btn" data-role="history-forget">${escapeHtml(t('historyForget'))}</button>
        </div>
      </details>
      <button class="sbgx-btn" data-role="cancel" hidden>${escapeHtml(t('cancel'))}</button>
      <button class="sbgx-btn sbgx-btn-primary" data-role="save-part" hidden></button>
      <span class="sbgx-tool sbgx-count" data-role="count">${escapeHtml(t('selectedCount', '0'))}</span>
      <button class="sbgx-btn sbgx-btn-link" data-role="clear" hidden>${escapeHtml(t('clearSelection'))}</button>
      <span class="sbgx-tool sbgx-trim-chip" data-role="trim-chip" hidden>
        <span data-role="trim-chip-text"></span>
        <button class="sbgx-trim-off" data-role="trim-off" title="${escapeHtml(t('trimTurnOff'))}">✕</button>
      </span>
      <span class="sbgx-tool sbgx-status" data-role="status">
        <span class="sbgx-spinner" data-role="spinner" hidden></span>
        <span class="sbgx-status-text" data-role="status-text"></span>
      </span>
      <span class="sbgx-spacer"></span>
      <a class="sbgx-kofi" href="${KOFI_URL}" target="_blank" rel="noopener" title="${koFiLabel}">
        <img src="${KOFI_IMAGE}" alt="${koFiLabel}" />
      </a>
      <div class="sbgx-failures" data-role="failures" hidden>
        <button class="sbgx-btn" data-role="retry"></button>
        <details>
          <summary>${escapeHtml(t('showFailures'))}</summary>
          <ul data-role="failures-list"></ul>
        </details>
      </div>
    `;
}
