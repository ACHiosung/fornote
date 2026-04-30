/**
 * Player - 음악 파일과 탬버린 효과음 재생, 마디 이동 기능
 */

class Player {
    constructor(noteData, renderer) {
        this.noteData = noteData;
        this.renderer = renderer;

        this.audioCtx = null;
        this.musicBuffer = null;
        this.tambourineBuffer = null;
        this._tambourineLoadPromise = null;

        this.musicSource = null;
        this.scheduledSources = [];

        this.isPlaying = false;
        this.startCtxTime = 0;   // audioCtx.currentTime when play() was called
        this.startOffset = 0;    // playback offset from song start (seconds)
        this._seeking = false;

        this.rafId = null;

        /** 재생 상태 변화 시 호출될 콜백 (isPlaying: boolean) */
        this.onPlayStateChange = null;
    }

    // 노트 수집 시 허용 타이밍 오차 (초): fromOffset 이전 노트도 여유 있게 포함
    static get NOTE_TIMING_TOLERANCE() { return 0.01; }
    // 오디오 스케줄링 최소 딜레이 임계값 (초): 너무 과거인 노트는 스킵
    static get SCHEDULE_PAST_THRESHOLD() { return 0.02; }
    // 재생 위치를 유지할 뷰포트 비율 (화면 상단에서): 0.3 = 상단 30% = 하단 70%
    static get SCROLL_VIEWPORT_RATIO() { return 0.3; }

    // ── AudioContext 초기화 (사용자 제스처 이후 호출) ──
    _ensureAudioContext() {
        if (!this.audioCtx || this.audioCtx.state === 'closed') {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
    }

    // ── 탬버린 효과음 로드 (sounds/tambourine.wav). 없으면 합성 클릭음으로 폴백 ──
    _ensureTambourine() {
        // 이미 준비됐으면 즉시 해결되는 Promise 반환
        if (this.tambourineBuffer) return Promise.resolve();
        // 로딩 중이면 같은 Promise를 재사용해 완료까지 대기
        if (this._tambourineLoadPromise) return this._tambourineLoadPromise;

        this._tambourineLoadPromise = (async () => {
            try {
                const resp = await fetch('sounds/tambourine.wav');
                if (resp.ok) {
                    const ab = await resp.arrayBuffer();
                    this.tambourineBuffer = await this.audioCtx.decodeAudioData(ab);
                    console.log('[Player] 탬버린 효과음 로드 완료');
                    return;
                }
                console.warn('[Player] sounds/tambourine.wav 없음 → 합성 클릭음으로 대체');
            } catch (e) {
                console.warn('[Player] 탬버린 로드 실패, 합성 클릭음으로 대체:', e.message);
            }
            // 폴백: Web Audio API로 짧은 클릭음(화이트노이즈 + 감쇠) 합성
            this.tambourineBuffer = this._makeSyntheticClick();
        })();

        return this._tambourineLoadPromise;
    }

    // ── 합성 클릭음 버퍼 생성 (50ms 화이트노이즈 + 지수 감쇠) ──
    _makeSyntheticClick() {
        const ctx = this.audioCtx;
        const duration = 0.05; // 50ms
        const sampleRate = ctx.sampleRate;
        const frameCount = Math.ceil(sampleRate * duration);
        const buffer = ctx.createBuffer(1, frameCount, sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < frameCount; i++) {
            // 화이트노이즈에 지수 감쇠 적용 → 타악기 느낌
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (frameCount * 0.15));
        }
        return buffer;
    }

    // ── 음악 파일 로드 ──
    async loadMusicFile(file) {
        this._ensureAudioContext();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    this.musicBuffer = await this.audioCtx.decodeAudioData(e.target.result);
                    console.log('[Player] 음악 파일 로드 완료:', file.name);
                    resolve(file.name);
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = () => reject(new Error('파일 읽기 실패'));
            reader.readAsArrayBuffer(file);
        });
    }

    // ── 절대 슬롯 → 재생 시간(초) 변환 (BPM 변화 반영) ──
    _getTimeForAbsSlot(absSlot) {
        const spm = this.noteData.slotsPerMeasure;
        const spb = this.noteData.slotsPerBeat;
        if (spb <= 0) return 0;

        const changes = (this.noteData.bpmChanges || [])
            .map(c => ({ absSlot: (c.measureIndex - 1) * spm + c.slotIndex, bpm: c.bpm }))
            .sort((a, b) => a.absSlot - b.absSlot);

        let time = 0;
        let curBpm = this.noteData.bpm;
        let curSlot = 0;

        for (const ch of changes) {
            if (ch.absSlot <= 0) { curBpm = ch.bpm; continue; }
            if (ch.absSlot >= absSlot) break;
            time += (ch.absSlot - curSlot) * (60 / (curBpm * spb));
            curSlot = ch.absSlot;
            curBpm = ch.bpm;
        }
        time += (absSlot - curSlot) * (60 / (curBpm * spb));
        return time;
    }

    // ── 재생 시간(초) → 절대 슬롯 변환 (소수 포함) ──
    _getAbsSlotForTime(timeSeconds) {
        const spm = this.noteData.slotsPerMeasure;
        const spb = this.noteData.slotsPerBeat;
        if (spb <= 0) return 0;

        const changes = (this.noteData.bpmChanges || [])
            .map(c => ({ absSlot: (c.measureIndex - 1) * spm + c.slotIndex, bpm: c.bpm }))
            .sort((a, b) => a.absSlot - b.absSlot);

        let elapsed = 0;
        let curBpm = this.noteData.bpm;
        let curSlot = 0;

        for (const ch of changes) {
            if (ch.absSlot <= 0) { curBpm = ch.bpm; continue; }
            const segTime = (ch.absSlot - curSlot) * (60 / (curBpm * spb));
            if (elapsed + segTime >= timeSeconds) break;
            elapsed += segTime;
            curSlot = ch.absSlot;
            curBpm = ch.bpm;
        }
        const remaining = timeSeconds - elapsed;
        return curSlot + remaining * (curBpm * spb) / 60;
    }

    // ── 탬버린을 울릴 노트 타이밍 수집 ──
    _collectNoteEvents(fromOffsetSeconds) {
        const spm = this.noteData.slotsPerMeasure;
        const total = this.noteData.totalMeasures;
        const hitAbsSlots = new Set();

        const addSlot = (absSlot) => {
            const t = this._getTimeForAbsSlot(absSlot);
            if (t >= fromOffsetSeconds - Player.NOTE_TIMING_TOLERANCE) hitAbsSlots.add(absSlot);
        };

        // normal / drag 레인: 비어있지 않은 모든 슬롯
        for (const prefix of ['normal', 'drag']) {
            for (let n = 1; n <= 3; n++) {
                const lane = `${prefix}_${n}`;
                for (let m = 1; m <= total; m++) {
                    const data = this.noteData.lanes[lane][m];
                    if (!data) continue;
                    for (let s = 0; s < data.length; s++) {
                        if (data[s] !== '0') addSlot((m - 1) * spm + s);
                    }
                }
            }
        }

        // long 레인: 연속 구간의 시작 슬롯만 (홀드 시작점)
        for (let n = 1; n <= 3; n++) {
            const lane = `long_${n}`;
            let prevWas1 = false;
            for (let m = 1; m <= total; m++) {
                const data = this.noteData.lanes[lane][m];
                if (!data) { prevWas1 = false; continue; }
                for (let s = 0; s < data.length; s++) {
                    if (data[s] === '1') {
                        if (!prevWas1) addSlot((m - 1) * spm + s);
                        prevWas1 = true;
                    } else {
                        prevWas1 = false;
                    }
                }
            }
        }

        return Array.from(hitAbsSlots)
            .map(absSlot => ({ absSlot, time: this._getTimeForAbsSlot(absSlot) }))
            .sort((a, b) => a.time - b.time);
    }

    // ── 재생 시작 (fromMeasure: 1-indexed) ──
    async play(fromMeasure = 1) {
        this._ensureAudioContext();
        await this._ensureTambourine();

        this._stopSources();

        const fromOffset = this._getTimeForAbsSlot(
            (fromMeasure - 1) * this.noteData.slotsPerMeasure
        );
        this.startOffset = fromOffset;
        this.startCtxTime = this.audioCtx.currentTime;
        this.isPlaying = true;

        // 음악 파일 재생
        if (this.musicBuffer) {
            this.musicSource = this.audioCtx.createBufferSource();
            this.musicSource.buffer = this.musicBuffer;
            this.musicSource.connect(this.audioCtx.destination);
            this.musicSource.start(0, fromOffset);
            this.musicSource.onended = () => {
                if (this.isPlaying && !this._seeking) this._onEnded();
            };
        }

        // 탬버린 스케줄링
        if (this.tambourineBuffer) {
            const now = this.audioCtx.currentTime;
            const events = this._collectNoteEvents(fromOffset);
            for (const ev of events) {
                const delay = ev.time - fromOffset;
                if (delay < -Player.SCHEDULE_PAST_THRESHOLD) continue;
                const src = this.audioCtx.createBufferSource();
                src.buffer = this.tambourineBuffer;
                src.connect(this.audioCtx.destination);
                src.start(now + Math.max(0, delay));
                this.scheduledSources.push(src);
            }
        }

        this._startRAF();
        if (this.onPlayStateChange) this.onPlayStateChange(true);
    }

    // ── 재생 중지 ──
    stop() {
        if (!this.isPlaying) return;
        this._stopSources();
        this._stopRAF();
        this.isPlaying = false;
        this.renderer.setPlaybackCursor(null);
        if (this.onPlayStateChange) this.onPlayStateChange(false);
    }

    // ── 마디로 이동 (재생 중에만 동작) ──
    seekToMeasure(measureIndex) {
        if (!this.isPlaying) return;
        const clamped = Math.max(1, Math.min(this.noteData.totalMeasures, measureIndex));
        this._seeking = true;
        this.play(clamped).finally(() => { this._seeking = false; });
    }

    // ── 현재 재생 시간(초) 반환 ──
    getCurrentTimeSeconds() {
        if (!this.isPlaying || !this.audioCtx) return this.startOffset;
        return (this.audioCtx.currentTime - this.startCtxTime) + this.startOffset;
    }

    // ── 현재 마디 번호(1-indexed) 반환 ──
    getCurrentMeasure() {
        const absSlot = this._getAbsSlotForTime(this.getCurrentTimeSeconds());
        return Math.floor(absSlot / this.noteData.slotsPerMeasure) + 1;
    }

    // ── 내부: 모든 소스 노드 정지 ──
    _stopSources() {
        if (this.musicSource) {
            // onended를 먼저 해제해 stop() 이후 비동기로 발화되는 이벤트가
            // _onEnded()를 잘못 호출하는 레이스 컨디션을 방지한다.
            this.musicSource.onended = null;
            try { this.musicSource.stop(); } catch (e) {
                if (e.name !== 'InvalidStateError') console.warn('[Player] musicSource.stop():', e.message);
            }
            this.musicSource = null;
        }
        for (const src of this.scheduledSources) {
            try { src.stop(); } catch (e) {
                if (e.name !== 'InvalidStateError') console.warn('[Player] scheduledSource.stop():', e.message);
            }
        }
        this.scheduledSources = [];
    }

    // ── 내부: 재생 자연 종료 처리 ──
    _onEnded() {
        this._stopRAF();
        this.isPlaying = false;
        this.renderer.setPlaybackCursor(null);
        if (this.onPlayStateChange) this.onPlayStateChange(false);
    }

    // ── 내부: 커서 업데이트 애니메이션 루프 ──
    _startRAF() {
        this._stopRAF();
        const tick = () => {
            if (!this.isPlaying) return;

            const t = this.getCurrentTimeSeconds();
            const absSlotF = this._getAbsSlotForTime(t);

            // 마지막 마디 이후이면 자동 정지
            const totalSlots = this.noteData.totalMeasures * this.noteData.slotsPerMeasure;
            if (absSlotF >= totalSlots) {
                this._onEnded();
                return;
            }

            // 커서 위치 갱신 및 자동 스크롤 (현재 위치를 화면 상단 SCROLL_VIEWPORT_RATIO 지점에 유지)
            this.renderer.setPlaybackCursor(absSlotF);
            const absoluteY = absSlotF * this.renderer.slotHeight;
            this.renderer.scrollY = Math.max(0, absoluteY - this.renderer.height * Player.SCROLL_VIEWPORT_RATIO);
            this.renderer.render();

            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    _stopRAF() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }
}
