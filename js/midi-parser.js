/**
 * MidiParser - @tonejs/midi 래퍼, MIDI 로드 및 노트 자동 인식
 * BPM, 박자, 곡 길이(마디 수)를 MIDI 파일에서 자동으로 읽어옵니다.
 *
 * ────────────────────────────────────────────
 *   해상도 = LCM(박자 분모, 3)
 *   → 분모 4  → LCM(4, 3)  = 12 slots/beat
 *   → 분모 8  → LCM(8, 3)  = 24 slots/beat
 *   → 분모 16 → LCM(16, 3) = 48 slots/beat
 * ────────────────────────────────────────────
 */

class MidiParser {
    constructor(noteData, renderer) {
        this.noteData = noteData;
        this.renderer = renderer;
        // true after the first MIDI file is loaded; locks BPM/TS for subsequent loads
        this.midiLoaded = false;
        this._checkLibrary();
    }

    _checkLibrary() {
        if (typeof Midi !== 'undefined') {
            this.MidiClass = Midi;
        } else if (typeof window !== 'undefined' && window.Midi) {
            this.MidiClass = window.Midi;
        } else {
            console.error('[MidiParser] @tonejs/midi 라이브러리가 로드되지 않았습니다!');
            this.MidiClass = null;
        }
    }

    // 최대공약수 (GCD)
    _gcd(a, b) {
        a = Math.abs(a);
        b = Math.abs(b);
        while (b) {
            [a, b] = [b, a % b];
        }
        return a;
    }

    // 최소공배수 (LCM)
    _lcm(a, b) {
        return (a * b) / this._gcd(a, b);
    }

    /**
     * 박자 분모(denominator)에서 slotsPerBeat 계산
     * 분모가 곧 1박 내 기본 분할 수이며, 셋잇단음표를 위해 3과의 LCM을 취함
     *
     *   den=4  → LCM(4, 3)  = 12
     *   den=8  → LCM(8, 3)  = 24
     *   den=16 → LCM(16, 3) = 48
     */
    _calcSlotsPerBeat(denominator) {
        return this._lcm(denominator, 3);
    }

    async parseFromBuffer(arrayBuffer, targetLane = 'normal_1') {
        if (!this.MidiClass) { this._checkLibrary(); }
        if (!this.MidiClass) {
            this.showNotification('❌ MIDI 라이브러리가 로드되지 않았습니다.', true);
            return;
        }

        try {
            const midi = new this.MidiClass(arrayBuffer);
            console.log('[MidiParser] MIDI 파싱 성공, 트랙:', midi.tracks.length);

            // 첫 번째 로드 여부를 미리 기록 (이 함수 내에서 midiLoaded가 변경되므로)
            const isFirstLoad = !this.midiLoaded;

            // ========== 1. MIDI에서 메타데이터 자동 추출 ==========

            // BPM 추출
            let bpm = 120;
            if (midi.header && midi.header.tempos && midi.header.tempos.length > 0) {
                bpm = midi.header.tempos[0].bpm;
            }

            // 박자 추출
            let tsNum = 4, tsDen = 4;
            if (midi.header && midi.header.timeSignatures && midi.header.timeSignatures.length > 0) {
                const ts = midi.header.timeSignatures[0].timeSignature;
                tsNum = ts[0]; // 분자
                tsDen = ts[1]; // 분모
            }

            // PPQ (Pulses Per Quarter Note) 추출 — tick 기반 정밀 변환에 사용
            const ppq = (midi.header && midi.header.ppq) ? midi.header.ppq : 480;

            // 첫 번째 MIDI 로드인 경우에만 메타데이터(BPM, 박자) 적용
            if (isFirstLoad) {
                // ────── 핵심: slotsPerBeat = LCM(분모, 3) ──────
                const slotsPerBeat = this._calcSlotsPerBeat(tsDen);

                // 곡 길이(초) → 총 마디 수 계산
                const durationSec = midi.duration; // 전체 길이 (초)
                const secondsPerBeat = 60 / bpm;
                const beatsPerMeasure = tsNum * (4 / tsDen); // 4분음표 기준 박자 수
                const secondsPerMeasure = secondsPerBeat * beatsPerMeasure;
                let totalMeasures = Math.ceil(durationSec / secondsPerMeasure) + 1; // 여유 1마디 추가
                if (totalMeasures < 1) totalMeasures = 1;

                console.log(`[MidiParser] ──────────────────────────────`);
                console.log(`[MidiParser] BPM = ${bpm}`);
                console.log(`[MidiParser] 박자 = ${tsNum}/${tsDen}`);
                console.log(`[MidiParser] PPQ = ${ppq}`);
                console.log(`[MidiParser] slotsPerBeat = LCM(${tsDen}, 3) = ${slotsPerBeat}`);
                console.log(`[MidiParser] 곡 길이 = ${durationSec.toFixed(1)}초, 총 마디 = ${totalMeasures}`);
                console.log(`[MidiParser] ──────────────────────────────`);

                // ========== 2. noteData & UI 업데이트 ==========
                this.noteData.updateMetadata(bpm, tsNum, tsDen, slotsPerBeat, totalMeasures);

                // UI 정보 표시 동기화
                document.getElementById('info-bpm').textContent = `BPM: ${bpm}`;
                document.getElementById('info-ts').textContent = `박자: ${tsNum}/${tsDen}`;
                document.getElementById('info-measures').textContent = `마디: ${totalMeasures}`;

                this.midiLoaded = true;
                // BPM 잠금 안내 표시
                const lockNotice = document.getElementById('midi-bpm-lock-notice');
                if (lockNotice) lockNotice.classList.remove('hidden');
            } else {
                // 이후 로드: BPM/박자는 첫 번째 MIDI 기준 유지, BPM 변화도 추가하지 않음
                bpm = this.noteData.bpm;
                tsNum = this.noteData.timeSignature.numerator;
                tsDen = this.noteData.timeSignature.denominator;
                console.log(`[MidiParser] 추가 MIDI 로드 — BPM/박자 잠금 유지 (${bpm}, ${tsNum}/${tsDen}), 라인: ${targetLane}`);
            }

            // 선택된 라인만 초기화
            this.noteData.lanes[targetLane] = {};

            // ========== 3. 노트 배치 ─ tick 기반 정밀 변환 ==========
            const slotsPerMeasure = this.noteData.slotsPerMeasure;
            const slotsPerBeat = this.noteData.slotsPerBeat;
            const secondsPerBeat = 60 / bpm;

            // MIDI PPQ 는 4분음표 기준이므로, 4분음표 = PPQ ticks
            // 1박(분모에 의한)의 tick 수 = ppq * (4 / tsDen)
            const ticksPerBeat = ppq * (4 / tsDen);
            const ticksPerSlot = ticksPerBeat / slotsPerBeat;

            let noteCount = 0;
            let skippedCount = 0;
            let quantizeWarnings = 0;

            midi.tracks.forEach((track, ti) => {
                if (track.notes.length === 0) return;
                console.log(`[MidiParser] 트랙 ${ti} (${track.name || '이름없음'}): ${track.notes.length} 노트`);

                track.notes.forEach((note, ni) => {
                    let absSlot;

                    if (typeof note.ticks === 'number') {
                        // ── tick 기반 변환 (가장 정확) ──
                        const rawSlot = note.ticks / ticksPerSlot;
                        absSlot = Math.round(rawSlot);

                        // 양자화 오차가 0.1슬롯 이상이면 경고
                        const error = Math.abs(rawSlot - absSlot);
                        if (error > 0.1 && quantizeWarnings < 20) {
                            console.warn(`  ⚠ note[${ni}] tick=${note.ticks}, rawSlot=${rawSlot.toFixed(3)} → quantized to ${absSlot} (error=${error.toFixed(3)})`);
                            quantizeWarnings++;
                        }
                    } else {
                        // tick이 없는 경우 시간 기반 폴백
                        const beatsElapsed = note.time / secondsPerBeat;
                        absSlot = Math.round(beatsElapsed * slotsPerBeat);
                    }

                    const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(absSlot);

                    if (measureIndex > this.noteData.totalMeasures) {
                        skippedCount++;
                        return;
                    }

                    if (ni < 10 && ti === 0) {
                        const tickInfo = typeof note.ticks === 'number' ? `tick=${note.ticks}` : '';
                        console.log(`  note[${ni}]: time=${note.time.toFixed(3)}s, ${tickInfo}, slot=${absSlot} → measure #${measureIndex}, pos ${slotIndex}/${slotsPerMeasure}`);
                    }

                    this.noteData.setSlot(targetLane, measureIndex, slotIndex, '1');
                    noteCount++;
                });
            });

            if (quantizeWarnings > 0) {
                console.warn(`[MidiParser] ${quantizeWarnings}개 노트에서 양자화 경고 발생 (해상도 밖의 리듬일 수 있음)`);
            }
            console.log(`[MidiParser] 완료: ${noteCount}개 배치, ${skippedCount}개 범위 초과 스킵`);

            // ========== 4. BPM 변화 이벤트 추출 (tick → 슬롯 변환, 첫 번째 로드 시에만) ==========
            if (isFirstLoad) {
                const bpmChangeList = [];
                if (midi.header && midi.header.tempos) {
                    midi.header.tempos.forEach((tempo) => {
                        // tick=0 이하는 초기 BPM으로 이미 처리됨 → 스킵
                        if (tempo.ticks <= 0) return;

                        const rawSlot = tempo.ticks / ticksPerSlot;
                        const absSlot = Math.round(rawSlot);
                        const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(absSlot);

                        if (measureIndex <= this.noteData.totalMeasures) {
                            bpmChangeList.push({
                                measureIndex,
                                slotIndex,
                                bpm: tempo.bpm,
                            });
                        }
                    });
                }
                this.noteData.bpmChanges = bpmChangeList;
                if (bpmChangeList.length > 0) {
                    console.log(`[MidiParser] BPM 변화 ${bpmChangeList.length}개 추출:`, bpmChangeList);
                }
            }

            // ========== 5. 첫 노트 마디 찾기 & 자동 스크롤 ==========
            let firstMeasureWithNote = -1;
            for (let m = 1; m <= this.noteData.totalMeasures; m++) {
                let d = this.noteData.lanes[targetLane][m];
                if (d && d.includes('1')) {
                    if (firstMeasureWithNote === -1) firstMeasureWithNote = m;
                }
            }

            if (noteCount === 0) {
                this.showNotification('⚠️ MIDI 파일에서 노트를 찾을 수 없습니다.', true);
                this.renderer.render();
            } else {
                const laneLabel = targetLane.replace('normal_', '일반 ');
                const bpmChangeList = this.noteData.bpmChanges || [];
                const bpmMsg = bpmChangeList.length > 0 ? `, BPM변화 ${bpmChangeList.length}회` : '';
                if (isFirstLoad) {
                    this.showNotification(`✅ [${laneLabel}] BPM=${this.noteData.bpm}, ${tsNum}/${tsDen}박, slotsPerBeat=${slotsPerBeat}, ${this.noteData.totalMeasures}마디, ${noteCount}개 노트 로드${bpmMsg}`);
                } else {
                    this.showNotification(`✅ [${laneLabel}] ${noteCount}개 노트 로드 (BPM/박자 고정 유지)${bpmMsg}`);
                }
                if (firstMeasureWithNote > 0) {
                    this.renderer.scrollToMeasure(firstMeasureWithNote);
                } else {
                    this.renderer.render();
                }
            }

        } catch (error) {
            console.error('[MidiParser] 파싱 실패:', error);
            this.showNotification('❌ MIDI 파싱 실패: ' + error.message, true);
        }
    }

    showNotification(msg, isError = false) {
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
