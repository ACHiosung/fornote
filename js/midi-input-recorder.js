/**
 * MidiInputRecorder - 실시간 MIDI 입력 녹음기
 *
 * Web MIDI API를 통해 MIDI 노트 및 클럭 신호를 수신하고,
 * 녹음된 이벤트를 NoteData에 맞게 변환하여 저장합니다.
 *
 * 지원 기능:
 *  - MIDI 클럭(0xF8) 기반 실시간 BPM 감지
 *  - 녹음 중 수동 BPM 변경 마커 삽입
 *  - 노트 온/오프 이벤트 기록 및 롱노트 판별
 *  - 녹음 종료 시 NoteData 슬롯으로 자동 변환
 */

class MidiInputRecorder {
    /**
     * @param {NoteData} noteData
     * @param {GridRenderer} renderer
     */
    constructor(noteData, renderer) {
        this.noteData = noteData;
        this.renderer = renderer;

        this.isRecording = false;
        this.recordStartTime = null;   // performance.now() 기준 (ms)

        // 녹음된 원본 이벤트: { timeMs, type: 'noteOn'|'noteOff', midiNote, velocity, midiChannel }
        this.recordedEvents = [];

        // BPM 변화 스냅샷: { timeMs, bpm }
        this.bpmSnapshots = [];

        // 현재 BPM (녹음 중 변경 가능)
        this.currentBpm = 120;

        // 녹음 파라미터 (startRecording 호출 시 설정)
        this.beatsPerBar = 4;
        this.slotsPerBeat = 12;
        this.targetLane = 'normal_1';   // 녹음할 레인
        this.longNoteThresholdBeats = 0.5; // 이 길이 이상이면 롱노트로 판별

        // Web MIDI API 핸들
        this.midiAccess = null;
        this._onMidiMessage = this._handleMidiMessage.bind(this);

        // MIDI 클럭 기반 BPM 감지
        this._clockTimes = [];          // 최근 클럭 타임스탬프 (ms)
        this._clockBpm = null;          // 감지된 BPM (null = 미감지)

        // 콜백 (UI 업데이트용)
        this.onBpmDetected = null;      // (bpm) => void
        this.onRecordingTick = null;    // (elapsedMs) => void – 매 0.5초마다 호출
        this._tickInterval = null;
    }

    // ─────────────────────────────────────────────
    //  초기화: Web MIDI API 접근 요청
    // ─────────────────────────────────────────────

    /**
     * Web MIDI API 접근을 요청하고 사용 가능한 입력 장치를 반환합니다.
     * @returns {Promise<MIDIInputMap|null>}
     */
    async init() {
        if (!navigator.requestMIDIAccess) {
            console.warn('[MidiInputRecorder] Web MIDI API를 지원하지 않는 브라우저입니다.');
            return null;
        }
        try {
            this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
            console.log('[MidiInputRecorder] MIDI 접근 허가됨, 입력 장치:', this.midiAccess.inputs.size);
            this.midiAccess.onstatechange = (e) => {
                console.log(`[MidiInputRecorder] 장치 상태 변경: ${e.port.name} → ${e.port.state}`);
            };
            return this.midiAccess.inputs;
        } catch (err) {
            console.error('[MidiInputRecorder] MIDI 접근 거부:', err);
            return null;
        }
    }

    /**
     * 현재 연결된 MIDI 입력 장치 목록을 배열로 반환합니다.
     * @returns {{ id: string, name: string }[]}
     */
    getInputDevices() {
        if (!this.midiAccess) return [];
        const devices = [];
        this.midiAccess.inputs.forEach((input) => {
            devices.push({ id: input.id, name: input.name });
        });
        return devices;
    }

    // ─────────────────────────────────────────────
    //  녹음 제어
    // ─────────────────────────────────────────────

    /**
     * 녹음을 시작합니다.
     * @param {object} options
     * @param {number}  options.bpm           초기 BPM
     * @param {number}  options.beatsPerBar   박자 분자 (예: 4/4 → 4)
     * @param {number}  options.slotsPerBeat  1박당 슬롯 수
     * @param {string}  options.targetLane    녹음 대상 레인 이름 (예: 'normal_1')
     * @param {number}  [options.longNoteThresholdBeats=0.5]  롱노트 판별 기준 (박)
     * @param {string}  [options.inputDeviceId]  특정 입력 장치 ID (없으면 모든 장치)
     */
    startRecording(options = {}) {
        if (this.isRecording) return;

        this.currentBpm        = options.bpm           ?? 120;
        this.beatsPerBar       = options.beatsPerBar   ?? 4;
        this.slotsPerBeat      = options.slotsPerBeat  ?? this.noteData.slotsPerBeat;
        this.targetLane        = options.targetLane    ?? 'normal_1';
        this.longNoteThresholdBeats = options.longNoteThresholdBeats ?? 0.5;

        this.recordedEvents = [];
        this.bpmSnapshots   = [{ timeMs: 0, bpm: this.currentBpm }];
        this._clockTimes    = [];
        this._clockBpm      = null;

        this.recordStartTime = performance.now();
        this.isRecording     = true;

        // 선택한 장치 또는 모든 장치에 리스너 등록
        if (this.midiAccess) {
            this.midiAccess.inputs.forEach((input) => {
                if (!options.inputDeviceId || input.id === options.inputDeviceId) {
                    input.addEventListener('midimessage', this._onMidiMessage);
                }
            });
        }

        // UI 틱 타이머 (500ms 간격)
        if (this.onRecordingTick) {
            this._tickInterval = setInterval(() => {
                if (this.isRecording && this.onRecordingTick) {
                    this.onRecordingTick(performance.now() - this.recordStartTime);
                }
            }, 500);
        }

        console.log(`[MidiInputRecorder] 녹음 시작 – BPM=${this.currentBpm}, lane=${this.targetLane}`);
    }

    /**
     * 녹음을 종료하고 NoteData로 변환합니다.
     */
    stopRecording() {
        if (!this.isRecording) return;
        this.isRecording = false;

        clearInterval(this._tickInterval);
        this._tickInterval = null;

        // 리스너 해제
        if (this.midiAccess) {
            this.midiAccess.inputs.forEach((input) => {
                input.removeEventListener('midimessage', this._onMidiMessage);
            });
        }

        const elapsed = performance.now() - this.recordStartTime;
        console.log(`[MidiInputRecorder] 녹음 종료 – 경과 ${(elapsed / 1000).toFixed(1)}초, 이벤트 ${this.recordedEvents.length}개`);

        this._processRecording();
    }

    /**
     * 녹음 중 BPM 변경 마커를 현재 시각에 삽입합니다.
     * @param {number} newBpm
     */
    markBpmChange(newBpm) {
        if (!this.isRecording) return;
        const timeMs = performance.now() - this.recordStartTime;
        this.currentBpm = newBpm;
        this.bpmSnapshots.push({ timeMs, bpm: newBpm });
        console.log(`[MidiInputRecorder] BPM 변경 마커: ${newBpm} @ ${timeMs.toFixed(0)}ms`);
    }

    // ─────────────────────────────────────────────
    //  MIDI 메시지 핸들러
    // ─────────────────────────────────────────────

    _handleMidiMessage(event) {
        const data = event.data;
        if (!data || data.length === 0) return;

        const statusByte = data[0];
        const timeMs = performance.now() - this.recordStartTime;

        // MIDI 타이밍 클럭 (0xF8) – BPM 감지
        if (statusByte === 0xF8) {
            this._updateClockBpm(timeMs);
            return;
        }

        const type    = statusByte & 0xF0;
        const channel = statusByte & 0x0F;

        if (data.length < 3) return;

        const midiNote = data[1];
        const velocity = data[2];

        if (type === 0x90 && velocity > 0) {
            // Note On
            this.recordedEvents.push({ timeMs, type: 'noteOn', midiNote, velocity, channel });
        } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
            // Note Off
            this.recordedEvents.push({ timeMs, type: 'noteOff', midiNote, velocity: 0, channel });
        }
    }

    /**
     * MIDI 클럭 간격으로 BPM을 추정합니다. (24 클럭 = 1 박자)
     * @param {number} timeMs
     */
    _updateClockBpm(timeMs) {
        this._clockTimes.push(timeMs);

        // 최근 25개(= 1박 이상)만 유지
        if (this._clockTimes.length > 25) {
            this._clockTimes.shift();
        }

        if (this._clockTimes.length >= 25) {
            const spanMs = this._clockTimes[this._clockTimes.length - 1] - this._clockTimes[0];
            // 24 간격 → 1 박자
            const beatMs = spanMs / 24;
            const detectedBpm = Math.round(60000 / beatMs);

            // 직전과 5BPM 이상 차이날 때만 업데이트
            if (Math.abs(detectedBpm - (this._clockBpm ?? 0)) >= 5) {
                this._clockBpm = detectedBpm;
                if (this.onBpmDetected) {
                    this.onBpmDetected(detectedBpm);
                }
            }
        }
    }

    // ─────────────────────────────────────────────
    //  녹음 데이터 → NoteData 변환
    // ─────────────────────────────────────────────

    /**
     * 녹음된 이벤트를 NoteData 슬롯으로 변환합니다.
     * 롱노트/드래그 레인인 경우 Note-On~Off 구간을 setRange로 채웁니다.
     * BPM 변화 정보는 noteData.bpmChanges에 저장됩니다.
     */
    _processRecording() {
        const lane = this.targetLane;
        const isLongLane = lane.startsWith('long_') || lane.startsWith('drag_');

        // 활성 노트 추적 (롱노트용)
        const activeNotes = new Map(); // midiNote → { timeMs, absSlot }

        let placedCount = 0;

        for (const evt of this.recordedEvents) {
            if (evt.type === 'noteOn') {
                const absSlot = this._timeMsToAbsSlot(evt.timeMs);
                activeNotes.set(evt.midiNote, { timeMs: evt.timeMs, absSlot });

                if (!isLongLane) {
                    // 일반 노트: 즉시 배치
                    const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(absSlot);
                    if (measureIndex <= this.noteData.totalMeasures) {
                        this.noteData.setSlot(lane, measureIndex, slotIndex, '1');
                        placedCount++;
                    }
                }
            } else if (evt.type === 'noteOff') {
                const start = activeNotes.get(evt.midiNote);
                if (!start) continue;
                activeNotes.delete(evt.midiNote);

                if (isLongLane) {
                    const absSlotStart = start.absSlot;
                    const absSlotEnd   = this._timeMsToAbsSlot(evt.timeMs);
                    const durationBeats = (evt.timeMs - start.timeMs) / this._msPerBeatAt(start.timeMs);

                    if (durationBeats >= this.longNoteThresholdBeats) {
                        this.noteData.setRange(lane, absSlotStart, absSlotEnd, '1');
                        placedCount++;
                    } else {
                        // 짧은 누름이면 단타로 처리
                        const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(absSlotStart);
                        if (measureIndex <= this.noteData.totalMeasures) {
                            this.noteData.setSlot(lane, measureIndex, slotIndex, '1');
                            placedCount++;
                        }
                    }
                }
            }
        }

        // 녹음 종료 시점에 아직 열려있는 노트 처리
        if (isLongLane) {
            const endTimeMs = performance.now() - this.recordStartTime;
            activeNotes.forEach((start, midiNote) => {
                const absSlotEnd = this._timeMsToAbsSlot(endTimeMs);
                this.noteData.setRange(lane, start.absSlot, absSlotEnd, '1');
                placedCount++;
            });
        }

        console.log(`[MidiInputRecorder] 변환 완료: ${placedCount}개 노트 배치`);

        // BPM 변화 정보를 noteData에 저장 (measureIndex는 1-indexed, 슬롯 단위 정밀도 유지)
        this.noteData.bpmChanges = this.bpmSnapshots
            .filter(snap => snap.timeMs > 0) // 초기 BPM은 #BPM 헤더로 처리
            .map(snap => {
                const absSlot = this._timeMsToAbsSlot(snap.timeMs);
                const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(absSlot);
                return { measureIndex, slotIndex, bpm: snap.bpm };
            });

        if (this.renderer) {
            this.renderer.render();
        }
    }

    // ─────────────────────────────────────────────
    //  시간 → 슬롯/마디 변환 유틸리티
    // ─────────────────────────────────────────────

    /**
     * 주어진 경과 시간(ms)에서의 1박자 길이(ms)를 반환합니다.
     * BPM 변화 스냅샷을 역순으로 검색합니다.
     * @param {number} timeMs
     * @returns {number}
     */
    _msPerBeatAt(timeMs) {
        let bpm = this.bpmSnapshots[0]?.bpm ?? this.currentBpm;
        for (const snap of this.bpmSnapshots) {
            if (snap.timeMs <= timeMs) bpm = snap.bpm;
            else break;
        }
        return 60000 / bpm;
    }

    /**
     * 경과 시간(ms)을 절대 슬롯 인덱스로 변환합니다.
     * BPM 변화를 구간별로 고려하여 정밀하게 계산합니다.
     * @param {number} timeMs
     * @returns {number}
     */
    _timeMsToAbsSlot(timeMs) {
        let accumulatedSlots = 0;
        const snapshots = this.bpmSnapshots;

        for (let i = 0; i < snapshots.length; i++) {
            const segStart = snapshots[i].timeMs;
            const segEnd   = (i + 1 < snapshots.length) ? snapshots[i + 1].timeMs : timeMs;
            const segBpm   = snapshots[i].bpm;

            if (timeMs <= segStart) break;

            const segDuration = Math.min(timeMs, segEnd) - segStart;
            const msPerBeat   = 60000 / segBpm;
            const msPerSlot   = msPerBeat / this.slotsPerBeat;

            accumulatedSlots += segDuration / msPerSlot;
        }

        return Math.round(accumulatedSlots);
    }

    /**
     * 경과 시간(ms)을 마디 인덱스(0-indexed)로 변환합니다.
     * @param {number} timeMs
     * @returns {number}
     */
    _timeMsToBarIndex(timeMs) {
        const absSlot = this._timeMsToAbsSlot(timeMs);
        const slotsPerMeasure = this.beatsPerBar * this.slotsPerBeat;
        return Math.floor(absSlot / slotsPerMeasure);
    }
}
