/**
 * TxtParser - exportToTXT() 로 생성된 TXT 파일을 다시 읽어들여 noteData 를 복원합니다.
 *
 * 지원 포맷:
 *   #BPM <value>          — 기본 BPM
 *   #BPM<XX> <value>      — BPM 변화 정의 (hex 인덱스)
 *   *-----...             — 구분선 / 주석 (무시)
 *   #<bar><ch>:<data>     — 노트 데이터 (bar=3자리 0-indexed, ch=2자리, data=hex 쌍)
 *
 * 채널 매핑:
 *   08 = BPM 변화
 *   11/12/13 = normal_1/2/3
 *   51/52/53 = long_1/2/3
 *   18/19/20 = drag_1/2/3
 */

class TxtParser {
    constructor(noteData, renderer) {
        this.noteData = noteData;
        this.renderer = renderer;
    }

    loadFromText(text) {
        try {
            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            let baseBpm = 120;
            const bpmValueMap = new Map(); // 'XX'(hex 대문자) → adjusted BPM 값
            const channelEntries = [];    // { bar, channel, pairCount, pairs[] }

            for (const line of lines) {
                // 구분선/주석 무시
                if (line.startsWith('*')) continue;

                // #BPM <value>  — 기본 BPM (hex 접미사 없음)
                const bpmBaseMatch = line.match(/^#BPM\s+([\d.]+)$/i);
                if (bpmBaseMatch) {
                    baseBpm = parseFloat(bpmBaseMatch[1]) || 120;
                    continue;
                }

                // #BPMxx <value>  — BPM 변화 정의
                const bpmDefMatch = line.match(/^#BPM([0-9A-Fa-f]{2})\s+([\d.]+)$/i);
                if (bpmDefMatch) {
                    bpmValueMap.set(bpmDefMatch[1].toUpperCase(), parseFloat(bpmDefMatch[2]));
                    continue;
                }

                // #<bar:3d><channel:2d>:<data>
                const dataMatch = line.match(/^#(\d{3})(\d{2}):([0-9A-Fa-f]*)$/);
                if (dataMatch) {
                    const bar = parseInt(dataMatch[1], 10);
                    const channel = parseInt(dataMatch[2], 10);
                    const rawData = dataMatch[3];
                    const pairCount = Math.floor(rawData.length / 2);
                    if (pairCount > 0) {
                        const pairs = [];
                        for (let i = 0; i < pairCount; i++) {
                            pairs.push(rawData.substring(i * 2, i * 2 + 2).toUpperCase());
                        }
                        channelEntries.push({ bar, channel, pairCount, pairs });
                    }
                }
            }

            if (channelEntries.length === 0) {
                this._showNotification('⚠️ 유효한 노트 데이터가 없습니다.', true);
                return;
            }

            // slotsPerMeasure = 모든 pairCount 의 LCM
            let slotsPerMeasure = 1;
            for (const { pairCount } of channelEntries) {
                slotsPerMeasure = NoteData._lcm(slotsPerMeasure, pairCount);
            }
            if (slotsPerMeasure < 1) slotsPerMeasure = 16;

            // 총 마디 수 결정
            let maxBar = 0;
            for (const { bar } of channelEntries) {
                if (bar > maxBar) maxBar = bar;
            }
            const totalMeasures = Math.max(40, maxBar + 2);

            // noteData 초기화 (4/4 박자 가정)
            const slotsPerBeat = (slotsPerMeasure % 4 === 0)
                ? slotsPerMeasure / 4
                : Math.max(1, Math.floor(slotsPerMeasure / 4));

            this.noteData.updateMetadata(baseBpm, 4, 4, slotsPerBeat, totalMeasures);

            // updateMetadata 가 slotsPerMeasure 를 num*slotsPerBeat 로 설정하므로
            // LCM 으로 계산한 값과 다를 경우 직접 보정
            if (this.noteData.slotsPerMeasure !== slotsPerMeasure) {
                this.noteData.slotsPerMeasure = slotsPerMeasure;
                this.noteData.activeGrid = slotsPerMeasure;
            }

            this.noteData.clearAll();

            const channelLaneMap = {
                11: 'normal_1', 12: 'normal_2', 13: 'normal_3',
                51: 'long_1',   52: 'long_2',   53: 'long_3',
                18: 'drag_1',   19: 'drag_2',   20: 'drag_3',
            };

            const bpmChanges = [];

            for (const { bar, channel, pairCount, pairs } of channelEntries) {
                const measureIndex = bar + 1; // 1-indexed
                if (measureIndex > totalMeasures) continue;

                const step = slotsPerMeasure / pairCount; // LCM 보장이므로 항상 정수

                if (channel === 8) {
                    // BPM 변화 채널
                    for (let i = 0; i < pairCount; i++) {
                        const pair = pairs[i];
                        if (pair === '00') continue;
                        const bpmVal = bpmValueMap.get(pair);
                        if (bpmVal !== undefined) {
                            bpmChanges.push({
                                measureIndex,
                                slotIndex: Math.round(i * step),
                                bpm: bpmVal,
                            });
                        }
                    }
                } else {
                    const lane = channelLaneMap[channel];
                    if (!lane) continue;

                    for (let i = 0; i < pairCount; i++) {
                        const pair = pairs[i];
                        if (pair === '00') continue;
                        const value = pair === '02' ? '2' : '1';
                        this.noteData.setSlot(lane, measureIndex, Math.round(i * step), value);
                    }
                }
            }

            this.noteData.bpmChanges = bpmChanges;

            // 로드된 노트 수 집계
            let noteCount = 0;
            for (const lane in this.noteData.lanes) {
                for (const m of Object.keys(this.noteData.lanes[lane])) {
                    const data = this.noteData.lanes[lane][m];
                    if (data) noteCount += (data.match(/[12]/g) || []).length;
                }
            }

            // 정보 바 업데이트
            document.getElementById('info-bpm').textContent = `BPM: ${baseBpm}`;
            document.getElementById('info-ts').textContent = `박자: 4/4`;
            document.getElementById('info-measures').textContent = `마디: ${totalMeasures}`;

            const bpmMsg = bpmChanges.length > 0 ? `, BPM변화 ${bpmChanges.length}회` : '';
            this._showNotification(
                `✅ TXT 로드: BPM=${baseBpm}, ${totalMeasures}마디, ${noteCount}개 노트${bpmMsg}`
            );

            this.renderer.scrollToMeasure(1);

        } catch (err) {
            console.error('[TxtParser] 파싱 실패:', err);
            this._showNotification('❌ TXT 파싱 실패: ' + err.message, true);
        }
    }

    _showNotification(msg, isError = false) {
        let toast = document.getElementById('toast-notification');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'toast-notification';
            document.body.appendChild(toast);
        }
        toast.style.cssText = `
            position: fixed; top: 70px; left: 50%; transform: translateX(-50%);
            background: ${isError ? 'rgba(255,50,50,0.95)' : 'rgba(0,230,118,0.95)'};
            color: ${isError ? '#fff' : '#000'}; padding: 14px 32px;
            border-radius: 8px; font-weight: 600; z-index: 9999;
            font-family: 'Inter', sans-serif; font-size: 14px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            transition: opacity 0.5s; opacity: 1;
        `;
        toast.textContent = msg;
        setTimeout(() => { toast.style.opacity = '0'; }, 4000);
    }
}
