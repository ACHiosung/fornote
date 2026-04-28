/**
 * NoteData - 코어 데이터 모델
 * 노트 데이터를 보관하고 관리합니다. (이진 문자열 기반)
 */

class NoteData {
    // ──── LCM / GCD 헬퍼 ────
    static _gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
    static _lcm(a, b) { return Math.round(a / NoteData._gcd(a, b)) * b; }

    constructor() {
        // 기본 메타데이터
        this.bpm = 120;
        this.timeSignature = { numerator: 4, denominator: 4 };
        this.totalMeasures = 40;

        // 현재 활성 그리드 (단일 정수, 스냅 기준)
        this.activeGrid = 16; // 기본값: 16등분
        // slotsPerMeasure = LCM(이전 spm, activeGrid) — 노트 손실을 막기 위해 단조증가만 허용
        this.slotsPerMeasure = this.activeGrid;
        // slotsPerBeat: MIDI 입력/녹음 양자화에 사용하는 1박당 슬롯 수
        this.slotsPerBeat = Math.max(1, Math.floor(this.slotsPerMeasure / this.timeSignature.numerator));

        // BPM 변화 기록: [{ measureIndex, slotIndex, bpm }, ...]  (measureIndex는 1-indexed)
        this.bpmChanges = [];

        // 박자 변화 기록: [{ measureIndex, slotIndex, numerator, denominator }, ...]
        this.tsChanges = [];

        // 9개 행 초기화
        this.lanes = {
            normal_1: {}, normal_2: {}, normal_3: {},
            long_1: {}, long_2: {}, long_3: {},
            drag_1: {}, drag_2: {}, drag_3: {}
        };
    }

    // 메타데이터 업데이트 (MIDI 파서 / UI 연결용)
    updateMetadata(bpm, num, den, slotsPerBeat, totalMeasures) {
        this.bpm = bpm;
        this.timeSignature.numerator = num;
        this.timeSignature.denominator = den;
        this.totalMeasures = totalMeasures;
        // MIDI 임포트: tick 해상도에서 파생된 마디 슬롯 수를 그대로 사용
        const midiSPM = num * slotsPerBeat;
        this.slotsPerBeat = slotsPerBeat;
        this.slotsPerMeasure = midiSPM;
        this.activeGrid = midiSPM;
        this.bpmChanges = [];
        this.tsChanges = [];
        console.log(`Metadata updated: BPM=${this.bpm}, TS=${num}/${den}, slotsPerBeat=${slotsPerBeat}, slotsPerMeasure=${this.slotsPerMeasure}`);
    }

    // 활성 그리드 변경 — slotsPerMeasure는 LCM(현재, n)으로만 증가 (기존 노트 위치 불변)
    setGrid(n) {
        if (!Number.isInteger(n) || n < 1) return;
        this.activeGrid = n;
        const newSPM = NoteData._lcm(this.slotsPerMeasure, n);
        if (newSPM !== this.slotsPerMeasure) {
            this._expandAllData(this.slotsPerMeasure, newSPM);
            this.slotsPerMeasure = newSPM;
            this.slotsPerBeat = Math.max(1, Math.floor(newSPM / this.timeSignature.numerator));
        }
    }

    // 슬롯 인덱스를 비례적으로 리맵핑 (해상도 증가 시에만 호출됨 — 데이터 손실 없음)
    _remapAllData(oldSPM, newSPM) {
        for (const lane in this.lanes) {
            for (const m of Object.keys(this.lanes[lane])) {
                const data = this.lanes[lane][m];
                if (!data) continue;
                const newData = new Array(newSPM).fill('0');
                for (let i = 0; i < Math.min(data.length, oldSPM); i++) {
                    if (data[i] !== '0') {
                        const newI = Math.round(i * newSPM / oldSPM);
                        if (newI < newSPM) newData[newI] = data[i];
                    }
                }
                this.lanes[lane][m] = newData.join('');
            }
        }
        // BPM 변화 슬롯도 리맵핑
        this.bpmChanges = this.bpmChanges.map(c => ({
            ...c,
            slotIndex: Math.round(c.slotIndex * newSPM / oldSPM)
        }));
    }

    // 배열을 LCM 확장 — 기존 노트 인덱스는 비례확장으로 정확히 보존 (그리드 변경 시 사용)
    _expandAllData(oldSPM, newSPM) {
        const factor = newSPM / oldSPM; // 항상 정수 (LCM 보장)
        for (const lane in this.lanes) {
            for (const m of Object.keys(this.lanes[lane])) {
                const data = this.lanes[lane][m];
                if (!data) continue;
                const newData = new Array(newSPM).fill('0');
                for (let i = 0; i < Math.min(data.length, oldSPM); i++) {
                    if (data[i] !== '0') {
                        const newI = i * factor; // 정수 배수이므로 정확
                        if (newI < newSPM) newData[newI] = data[i];
                    }
                }
                this.lanes[lane][m] = newData.join('');
            }
        }
        // BPM 변화 슬롯도 확장
        this.bpmChanges = this.bpmChanges.map(c => ({
            ...c,
            slotIndex: c.slotIndex * factor
        }));
    }

    // 마디 내 점유 슬롯에서 최소 필요 해상도 계산 (export용)
    // 예: spm=20, 점유={0,5,10,15} → 4, 점유={0,4,8,12,16} → 5, 점유={0,4,5,10} → 20
    _minResolutionForData(rawData, spm) {
        let g = spm;
        for (let i = 0; i < rawData.length; i++) {
            if (rawData[i] !== '0' && i > 0) {
                g = NoteData._gcd(g, i);
                if (g === 1) break;
            }
        }
        return spm / g;
    }

    // 마디의 특정 레인 데이터 문자열 가져오기
    getMeasureData(laneName, measureIndex) {
        if (measureIndex < 1 || measureIndex > this.totalMeasures) return null;
        const data = this.lanes[laneName][measureIndex];
        if (data && data.length === this.slotsPerMeasure) return data;
        // 데이터 길이가 다르면 현재 길이에 맞춰서 패딩 또는 자르기
        if (data && data.length !== this.slotsPerMeasure) {
            if (data.length < this.slotsPerMeasure) {
                return data + "0".repeat(this.slotsPerMeasure - data.length);
            }
            return data.substring(0, this.slotsPerMeasure);
        }
        return "0".repeat(this.slotsPerMeasure);
    }

    // 특정 슬롯 1 설정
    setSlot(laneName, measureIndex, slotIndex, value = "1") {
        let measureData = this.getMeasureData(laneName, measureIndex);
        if (!measureData) return;
        if (slotIndex < 0 || slotIndex >= this.slotsPerMeasure) return;
        
        let chars = measureData.split('');
        chars[slotIndex] = value;
        this.lanes[laneName][measureIndex] = chars.join('');
    }

    // 일반 노트 토글용 (0 <-> 1)
    toggleSlot(laneName, measureIndex, slotIndex) {
        let measureData = this.getMeasureData(laneName, measureIndex);
        if (!measureData) return;
        if (slotIndex < 0 || slotIndex >= this.slotsPerMeasure) return;

        let chars = measureData.split('');
        chars[slotIndex] = chars[slotIndex] === '1' ? '0' : '1';
        this.lanes[laneName][measureIndex] = chars.join('');
    }

    // 드래그 노트 사이클용 (0 → 1 → 2 → 0)
    toggleDragSlot(laneName, measureIndex, slotIndex) {
        let measureData = this.getMeasureData(laneName, measureIndex);
        if (!measureData) return;
        if (slotIndex < 0 || slotIndex >= this.slotsPerMeasure) return;

        let chars = measureData.split('');
        const cur = chars[slotIndex];
        if (cur === '0') chars[slotIndex] = '1';
        else if (cur === '1') chars[slotIndex] = '2';
        else chars[slotIndex] = '0';
        this.lanes[laneName][measureIndex] = chars.join('');
    }

    // 마디 전체 범위 설정 (1 또는 0으로)
    fillMeasureRange(laneName, measureIndex, startSlot, endSlot, value = "1") {
        let measureData = this.getMeasureData(laneName, measureIndex);
        if (!measureData) return;
        let chars = measureData.split('');
        for (let i = startSlot; i <= endSlot; i++) {
            if (i >= 0 && i < this.slotsPerMeasure) {
                chars[i] = value;
            }
        }
        this.lanes[laneName][measureIndex] = chars.join('');
    }

    // 전역 슬롯 인덱스 (Absolute Slot Index) <-> (measureIndex, slotIndex) 변환
    getAbsoluteSlotIndex(measureIndex, slotIndex) {
        return (measureIndex - 1) * this.slotsPerMeasure + slotIndex;
    }

    getMeasureAndSlotFromAbsolute(absSlotIndex) {
        if (absSlotIndex < 0) absSlotIndex = 0;
        const measureIndex = Math.floor(absSlotIndex / this.slotsPerMeasure) + 1;
        const slotIndex = absSlotIndex % this.slotsPerMeasure;
        return { measureIndex, slotIndex };
    }

    // 롱노트/드래그범위 설정 (마디를 넘어갈 수 있음)
    setRange(laneName, absStart, absEnd, value = "1") {
        let start = Math.min(absStart, absEnd);
        let end = Math.max(absStart, absEnd);

        for (let i = start; i <= end; i++) {
            let { measureIndex, slotIndex } = this.getMeasureAndSlotFromAbsolute(i);
            if (measureIndex > this.totalMeasures) break;
            this.setSlot(laneName, measureIndex, slotIndex, value);
        }
    }

    // 전체 데이터 클리어
    clearAll() {
        for (let lane in this.lanes) {
            this.lanes[lane] = {};
        }
        this.bpmChanges = [];
        this.tsChanges = [];
    }

    // 박자 변화 추가 (같은 위치에 이미 있으면 교체)
    addTsChange(measureIndex, slotIndex, numerator, denominator) {
        this.tsChanges = this.tsChanges.filter(
            c => !(c.measureIndex === measureIndex && c.slotIndex === slotIndex)
        );
        this.tsChanges.push({ measureIndex, slotIndex, numerator, denominator });
    }

    // 박자 변화 삭제
    removeTsChange(measureIndex, slotIndex) {
        this.tsChanges = this.tsChanges.filter(
            c => !(c.measureIndex === measureIndex && c.slotIndex === slotIndex)
        );
    }

    // MIDI에서 추출된 노트를 Normal 1에만 추가합니다.
    addNoteFromAbsoluteTime(absSlotIndex) {
        let { measureIndex, slotIndex } = this.getMeasureAndSlotFromAbsolute(absSlotIndex);
        if (measureIndex > this.totalMeasures) return;

        // Normal 1에만 배치 (중복 위치 무시)
        this.setSlot('normal_1', measureIndex, slotIndex, '1');
    }

    // 데이터를 Export 포맷 텍스트로 변환 (txtTojson.cs 호환 형식)
    exportToTXT() {
        // 박자(시그니처)를 반영한 실제 BPM 계산:
        // 4/4 기준으로 환산 → adjustedBpm = bpm * denominator / numerator
        // 예) 2/4, BPM 100 → 100 * 4/2 = 200, 소수점 2자리까지 표시
        const { numerator, denominator } = this.timeSignature;
        const adjustBpm = (rawBpm) => {
            const v = rawBpm * denominator / numerator;
            if (Number.isInteger(v)) return v;
            return parseFloat(v.toFixed(2));
        };

        let txt = `#BPM ${adjustBpm(this.bpm)}\n`;

        // ── BPM 변화 정의 헤더: 고유 raw BPM 값마다 #BPMxx value ──
        // 0abcb94 방식: Map 키 = raw BPM, channel 08 조회도 raw BPM 기준
        const bpmValueSet = new Set(this.bpmChanges.map(c => c.bpm));
        const bpmValues = Array.from(bpmValueSet).sort((a, b) => a - b);
        const bpmIndexMap = new Map();
        bpmValues.forEach((val, i) => {
            bpmIndexMap.set(val, (i + 1).toString(16).padStart(2, '0').toUpperCase());
        });
        for (const [val, idx] of bpmIndexMap) {
            txt += `#BPM${idx} ${adjustBpm(val)}\n`;
        }

        txt += `*---------------------- MAIN DATA FIELD\n`;

        const laneChannelMap = {
            normal_1: 11,
            normal_2: 12,
            normal_3: 13,
            long_1:   51,
            long_2:   52,
            long_3:   53,
            drag_1:   18,
            drag_2:   19,
            drag_3:   20,
        };

        const lanesOrder = [
            'normal_1', 'normal_2', 'normal_3',
            'long_1', 'long_2', 'long_3',
            'drag_1', 'drag_2', 'drag_3'
        ];

        for (const lane of lanesOrder) {
            const channel = laneChannelMap[lane];
            const isDrag = lane.startsWith('drag');

            for (let m = 1; m <= this.totalMeasures; m++) {
                const rawData = this.getMeasureData(lane, m); // 길이 = slotsPerMeasure

                // 점유된 슬롯이 없으면 출력 생략
                if (!rawData.includes('1') && !rawData.includes('2')) continue;

                // 이 마디에 필요한 최소 해상도 계산 (점유 슬롯 기반 LCM)
                const minRes = this._minResolutionForData(rawData, this.slotsPerMeasure);
                const step = this.slotsPerMeasure / minRes; // rawData에서 step칸마다 샘플링

                // minRes 길이의 export 슬롯 배열 구성
                let mData = '';
                for (let i = 0; i < minRes; i++) {
                    const v = rawData[i * step];
                    if (v === '1') mData += '01';
                    else if (isDrag && v === '2') mData += '02';
                    else mData += '00';
                }

                const bar = (m - 1).toString().padStart(3, '0');
                txt += `#${bar}${channel.toString().padStart(2, '0')}:${mData}\n`;
            }
        }

        // ── BPM 변화 채널 (channel 08): raw BPM 기준 인덱스 조회 (0abcb94 방식) ──
        if (this.bpmChanges.length > 0) {
            const bpmByMeasure = new Map();
            for (const change of this.bpmChanges) {
                if (!bpmByMeasure.has(change.measureIndex)) {
                    bpmByMeasure.set(change.measureIndex, []);
                }
                bpmByMeasure.get(change.measureIndex).push(change);
            }

            const sortedMeasures = Array.from(bpmByMeasure.keys()).sort((a, b) => a - b);
            for (const measureIndex of sortedMeasures) {
                const bar = (measureIndex - 1).toString().padStart(3, '0');
                // BPM 변화 슬롯에서 최소 해상도 계산
                const changes = bpmByMeasure.get(measureIndex);
                const rawSlots = new Array(this.slotsPerMeasure).fill(null);
                for (const change of changes) {
                    const idx = bpmIndexMap.get(change.bpm);
                    if (idx !== undefined && change.slotIndex >= 0 && change.slotIndex < this.slotsPerMeasure) {
                        rawSlots[change.slotIndex] = idx;
                    }
                }
                // 점유 여부만으로 minRes 계산 (null이 아닌 위치)
                let g = this.slotsPerMeasure;
                for (let i = 1; i < rawSlots.length; i++) {
                    if (rawSlots[i] !== null) { g = NoteData._gcd(g, i); if (g === 1) break; }
                }
                const minRes = this.slotsPerMeasure / g;
                const step = this.slotsPerMeasure / minRes;
                const slots = [];
                for (let i = 0; i < minRes; i++) {
                    slots.push(rawSlots[i * step] !== null ? rawSlots[i * step] : '00');
                }
                const lineData = slots.join('');
                if (lineData !== '00'.repeat(minRes)) {
                    txt += `#${bar}08:${lineData}\n`;
                }
            }
        }

        return txt;
    }
}
