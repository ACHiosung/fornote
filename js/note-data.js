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

        // 박자 변화 기록: [{ measureIndex, slotIndex, numerator, denominator }, ...]
        this.tsChanges = [];

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
        // MIDI 파일 로드 시 BPM/박자 변화 기록 초기화 (MIDI 파일 자체에서 재설정됨)
        this.bpmChanges = [];
        this.tsChanges = [];
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
        // ── TXT 포맷용 유효 BPM: rawBpm × den ÷ num (박자 기준 정규화) ──
        // 에디터 표시는 MIDI 원본 BPM(this.bpm)을 그대로 사용하며,
        // TXT 파일에는 현재 박자 분모/분자로 보정한 값을 기록합니다.
        const computeEffectiveBpm = (rawBpm, num, den) => {
            const v = rawBpm * den / num;
            return Number.isInteger(v) ? v : Math.round(v * 100) / 100;
        };

        const initNum = this.timeSignature.numerator;
        const initDen = this.timeSignature.denominator;
        let txt = `#BPM ${computeEffectiveBpm(this.bpm, initNum, initDen)}\n`;

        // ── bpmChanges + tsChanges를 절대 슬롯 위치 기준으로 병합 ──
        // 박자가 바뀌면 유효 BPM도 달라지므로 두 이벤트를 모두 반영합니다.
        const allEvents = [];
        for (const c of this.bpmChanges) {
            allEvents.push({
                absSlot: (c.measureIndex - 1) * this.slotsPerMeasure + c.slotIndex,
                measureIndex: c.measureIndex, slotIndex: c.slotIndex,
                type: 'bpm', bpm: c.bpm,
            });
        }
        for (const c of this.tsChanges) {
            allEvents.push({
                absSlot: (c.measureIndex - 1) * this.slotsPerMeasure + c.slotIndex,
                measureIndex: c.measureIndex, slotIndex: c.slotIndex,
                type: 'ts', numerator: c.numerator, denominator: c.denominator,
            });
        }
        allEvents.sort((a, b) => a.absSlot - b.absSlot || (a.type === 'bpm' ? -1 : 1));

        // 상태를 추적하며 각 변경 시점의 유효 BPM을 계산
        let curBpm = this.bpm;
        let curNum = initNum;
        let curDen = initDen;
        const effectiveChanges = [];
        let i = 0;
        while (i < allEvents.length) {
            const posSlot = allEvents[i].absSlot;
            const { measureIndex, slotIndex } = allEvents[i];
            while (i < allEvents.length && allEvents[i].absSlot === posSlot) {
                const ev = allEvents[i];
                if (ev.type === 'bpm') curBpm = ev.bpm;
                else { curNum = ev.numerator; curDen = ev.denominator; }
                i++;
            }
            effectiveChanges.push({
                measureIndex,
                slotIndex,
                effectiveBpm: computeEffectiveBpm(curBpm, curNum, curDen),
            });
        }

        // ── 고유 유효 BPM 값 → 2자리 대문자 16진수 인덱스 매핑 ──
        const effectiveBpmSet = new Set(effectiveChanges.map(c => c.effectiveBpm));
        const effectiveBpmValues = Array.from(effectiveBpmSet).sort((a, b) => a - b);
        const bpmIndexMap = new Map();
        effectiveBpmValues.forEach((val, idx) => {
            bpmIndexMap.set(val, (idx + 1).toString(16).padStart(2, '0').toUpperCase());
        });
        for (const [val, idx] of bpmIndexMap) {
            txt += `#BPM${idx} ${val}\n`;
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

        // ── 유효 BPM 변화 채널 (channel 08): bpmChanges + tsChanges 통합 ──
        if (effectiveChanges.length > 0) {
            const changesByMeasure = new Map();
            for (const change of effectiveChanges) {
                if (!changesByMeasure.has(change.measureIndex)) {
                    changesByMeasure.set(change.measureIndex, []);
                }
                changesByMeasure.get(change.measureIndex).push(change);
            }

            const sortedMeasures = Array.from(changesByMeasure.keys()).sort((a, b) => a - b);
            for (const measureIndex of sortedMeasures) {
                const bar = (measureIndex - 1).toString().padStart(3, '0');
                const slots = new Array(this.slotsPerMeasure).fill('00');
                for (const change of changesByMeasure.get(measureIndex)) {
                    const idx = bpmIndexMap.get(change.effectiveBpm);
                    if (idx !== undefined && change.slotIndex >= 0 && change.slotIndex < this.slotsPerMeasure) {
                        slots[change.slotIndex] = idx;
                    }
                }
                const lineData = slots.join('');
                if (lineData !== '00'.repeat(this.slotsPerMeasure)) {
                    txt += `#${bar}08:${lineData}\n`;
                }
            }
        }

        return txt;
    }
}
