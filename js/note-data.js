/**
 * NoteData - 코어 데이터 모델
 * 노트 데이터를 보관하고 관리합니다. (이진 문자열 기반)
 */

class NoteData {
    constructor() {
        // 기본 메타데이터
        this.bpm = 120;
        this.timeSignature = { numerator: 4, denominator: 4 };
        this.slotsPerBeat = 24; // LCM(분모4, 3) = 12 (16분음표+셋잇단 모두 표현)
        this.totalMeasures = 40;

        // 마디 크기(슬롯 수) 계산
        this.slotsPerMeasure = this.timeSignature.numerator * this.slotsPerBeat;

        // BPM 변화 기록: [{ measureIndex, slotIndex, bpm }, ...]  (measureIndex는 1-indexed)
        this.bpmChanges = [];

        // 9개 행 초기화
        this.lanes = {
            normal_1: {}, normal_2: {}, normal_3: {},
            long_1: {}, long_2: {}, long_3: {},
            drag_1: {}, drag_2: {}, drag_3: {}
        };
    }

    // 메타데이터 업데이트 (UI 연결용)
    updateMetadata(bpm, num, den, slotsPerBeat, totalMeasures) {
        this.bpm = bpm;
        this.timeSignature.numerator = num;
        this.timeSignature.denominator = den;
        this.slotsPerBeat = slotsPerBeat;
        this.totalMeasures = totalMeasures;
        // slotsPerBeat는 이미 분모(den) 기준이므로, 단순히 분자 × slotsPerBeat
        // 예: 4/4 → 4 * 12 = 48, 6/8 → 6 * 24 = 144, 4/16 → 4 * 48 = 192
        this.slotsPerMeasure = num * slotsPerBeat;
        // MIDI 파일 로드 시 BPM 변화 기록 초기화 (MIDI 파일 자체에서 재설정됨)
        this.bpmChanges = [];
        console.log(`Metadata updated: BPM=${this.bpm}, TS=${num}/${den}, slotsPerBeat=${slotsPerBeat}, slotsPerMeasure=${this.slotsPerMeasure}`);
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
        let txt = `#BPM ${this.bpm}\n`;

        // BPM 변화 헤더 라인 (#BPMCHANGE 형식) – measureIndex는 1-indexed
        for (const change of this.bpmChanges) {
            const bar = (change.measureIndex - 1).toString().padStart(3, '0');
            txt += `#BPMCHANGE ${bar} 08 ${change.bpm}\n`;
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

            for (let m = 1; m <= this.totalMeasures; m++) {
                let mData = this.getMeasureData(lane, m);

                mData = mData
                    .split('')
                    .map(v => v === '1' ? '01' : '00')
                    .join('');

                if (mData.includes('1')) {
                    const bar = (m - 1).toString().padStart(3, '0');
                    txt += `#${bar}${channel.toString().padStart(2, '0')}:${mData}\n`;
                }
            }
        }

        return txt;
    }
}
