/**
 * App - 메인 애플리케이션 초기화 및 이벤트 바인딩
 */

document.addEventListener('DOMContentLoaded', () => {
    // 1. 코어 인스턴스 초기화
    const noteData = new NoteData();
    const renderer = new GridRenderer('grid-canvas', noteData);
    const editor = new Editor('grid-canvas', noteData, renderer);
    const midiParser = new MidiParser(noteData, renderer);
    const exporter = new Exporter(noteData);
    const midiRecorder = new MidiInputRecorder(noteData, renderer);
    const player = new Player(noteData, renderer);

    // editor에 player 주입 (재생 중 휠 이동에 사용)
    editor.player = player;

    // 2a. 최상위 에디터 모드 버튼 (✏️ 노트 / 🖱️ 편집)
    const editorModeBtns   = document.querySelectorAll('.editor-mode-btn');
    const noteModeOptions  = document.getElementById('note-mode-options');
    const helpTextNote     = document.getElementById('help-text-note');
    const helpTextEdit     = document.getElementById('help-text-edit');

    editorModeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            editorModeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const mode = btn.dataset.editorMode;
            editor.setEditorMode(mode);
            // 노트 모드 서브 옵션 표시/숨김
            noteModeOptions.style.display = mode === 'note' ? '' : 'none';
            // 도움말 텍스트 전환
            helpTextNote.style.display = mode === 'note' ? '' : 'none';
            helpTextEdit.style.display = mode === 'edit' ? '' : 'none';
        });
    });

    // 2b. 노트 모드 내 서브 모드 버튼 (쓰기 / 지우개)
    const modeBtns = document.querySelectorAll('.tool-btn');
    modeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            modeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            editor.setMode(btn.dataset.mode);
        });
    });

    // 4. MIDI 파일 업로드
    document.getElementById('midi-upload').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const targetLane = document.getElementById('midi-target-lane').value || 'normal_1';

        const reader = new FileReader();
        reader.onload = async (event) => {
            await midiParser.parseFromBuffer(event.target.result, targetLane);
            e.target.value = '';
        };
        reader.readAsArrayBuffer(file);
    });

    // 5. TXT 내보내기
    document.getElementById('export-txt-btn').addEventListener('click', () => {
        exporter.downloadTXT();
    });

    // ─────────────────────────────────────────────
    //  5b. 음악 파일 로드 & 재생 버튼
    // ─────────────────────────────────────────────

    const musicUpload   = document.getElementById('music-upload');
    const musicFilename = document.getElementById('music-filename');
    const playBtn       = document.getElementById('play-btn');

    musicUpload.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            await player.loadMusicFile(file);
            musicFilename.textContent = file.name;
            musicFilename.style.display = '';
        } catch (err) {
            alert('음악 파일 로드 실패: ' + err.message);
        }
        e.target.value = '';
    });

    playBtn.addEventListener('click', () => {
        if (player.isPlaying) {
            player.stop();
        } else {
            player.play(1);
        }
    });

    player.onPlayStateChange = (isPlaying) => {
        playBtn.textContent = isPlaying ? '■ 정지' : '▶ 재생';
        playBtn.classList.toggle('playing', isPlaying);
    };

    // 6. 줌 컨트롤
    document.getElementById('zoom-in-btn').addEventListener('click', () => {
        renderer.setZoom(4);
    });

    document.getElementById('zoom-out-btn').addEventListener('click', () => {
        renderer.setZoom(-4);
    });

    document.getElementById('zoom-fit-btn').addEventListener('click', () => {
        renderer.zoomFit();
    });

    // ─────────────────────────────────────────────
    //  7. MIDI 녹음 패널
    // ─────────────────────────────────────────────

    const recordPanel       = document.getElementById('record-panel');
    const recordInitBtn     = document.getElementById('midi-record-init-btn');
    const deviceSelect      = document.getElementById('record-device-select');
    const refreshBtn        = document.getElementById('record-refresh-btn');
    const laneSelect        = document.getElementById('record-lane-select');
    const bpmInput          = document.getElementById('record-bpm-input');
    const startBtn          = document.getElementById('record-start-btn');
    const stopBtn           = document.getElementById('record-stop-btn');
    const bpmChangeBtn      = document.getElementById('record-bpmchange-btn');
    const bpmChangeInput    = document.getElementById('record-bpmchange-input');
    const statusLabel       = document.getElementById('record-status');
    const clockBpmLabel     = document.getElementById('record-clock-bpm');

    // 장치 목록을 select에 채우는 헬퍼
    function populateDevices() {
        const devices = midiRecorder.getInputDevices();
        const current = deviceSelect.value;
        deviceSelect.innerHTML = '<option value="">-- 장치 선택 --</option>';
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.name;
            deviceSelect.appendChild(opt);
        });
        // 이전 선택 복원
        if (current) deviceSelect.value = current;

        if (devices.length === 0) {
            deviceSelect.innerHTML = '<option value="">장치 없음</option>';
        }
    }

    // 녹음 패널 토글 버튼 – 처음 열 때 MIDI 초기화
    let midiInitialized = false;
    recordInitBtn.addEventListener('click', async () => {
        const isHidden = recordPanel.classList.contains('hidden');
        if (isHidden) {
            recordPanel.classList.remove('hidden');
            if (!midiInitialized) {
                statusLabel.textContent = 'MIDI 초기화 중…';
                const inputs = await midiRecorder.init();
                midiInitialized = true;
                if (inputs) {
                    populateDevices();
                    statusLabel.textContent = `장치 ${midiRecorder.getInputDevices().length}개 감지됨`;
                } else {
                    statusLabel.textContent = 'Web MIDI API 미지원 또는 권한 거부';
                }
            }
        } else {
            recordPanel.classList.add('hidden');
        }
    });

    // 장치 목록 새로고침
    refreshBtn.addEventListener('click', () => {
        populateDevices();
    });

    // BPM 입력값을 bpmChangeInput 기본값과 동기화
    bpmInput.addEventListener('input', () => {
        if (!midiRecorder.isRecording) {
            bpmChangeInput.value = bpmInput.value;
        }
    });

    // 녹음 시작
    startBtn.addEventListener('click', () => {
        const bpm = parseFloat(bpmInput.value) || 120;
        const lane = laneSelect.value;
        const deviceId = deviceSelect.value || undefined;

        noteData.bpm = bpm;
        bpmChangeInput.value = bpm;

        midiRecorder.onBpmDetected = (detectedBpm) => {
            clockBpmLabel.textContent = `클럭 BPM: ${detectedBpm}`;
            clockBpmLabel.classList.remove('hidden');
        };

        midiRecorder.onRecordingTick = (elapsedMs) => {
            const sec = (elapsedMs / 1000).toFixed(1);
            statusLabel.textContent = `● 녹음 중… ${sec}s`;
        };

        midiRecorder.startRecording({
            bpm,
            beatsPerBar:  noteData.timeSignature.numerator,
            slotsPerBeat: noteData.slotsPerBeat,
            targetLane:   lane,
            inputDeviceId: deviceId,
        });

        // UI 상태 전환
        startBtn.disabled       = true;
        stopBtn.disabled        = false;
        bpmChangeBtn.disabled   = false;
        bpmChangeInput.disabled = false;
        bpmInput.disabled       = true;
        laneSelect.disabled     = true;
        deviceSelect.disabled   = true;
        statusLabel.textContent = '● 녹음 중…';
        statusLabel.classList.add('recording');
        clockBpmLabel.classList.add('hidden');

        document.getElementById('info-bpm').textContent = `BPM: ${bpm}`;
    });

    // 녹음 종료
    stopBtn.addEventListener('click', () => {
        midiRecorder.stopRecording();

        // UI 상태 복원
        startBtn.disabled       = false;
        stopBtn.disabled        = true;
        bpmChangeBtn.disabled   = true;
        bpmChangeInput.disabled = true;
        bpmInput.disabled       = false;
        laneSelect.disabled     = false;
        deviceSelect.disabled   = false;
        statusLabel.textContent = '녹음 완료';
        statusLabel.classList.remove('recording');

        midiParser.showNotification('✅ 녹음 완료');
    });

    // 녹음 중 BPM 변경 마커 삽입
    bpmChangeBtn.addEventListener('click', () => {
        const newBpm = parseFloat(bpmChangeInput.value);
        if (!newBpm || newBpm <= 0) return;
        midiRecorder.markBpmChange(newBpm);
        noteData.bpm = newBpm;
        document.getElementById('info-bpm').textContent = `BPM: ${newBpm}`;
        midiParser.showNotification(`♩ BPM → ${newBpm}`);
    });

    // 8. 그리드 분할 수 조절 (activeGrid = n, slotsPerMeasure = LCM 누적, 노트 위치 불변)
    function syncGridUI() {
        const active = noteData.activeGrid;
        const gridInput = document.getElementById('grid-input');
        if (gridInput) gridInput.value = active;
        document.querySelectorAll('.grid-preset-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.grid, 10) === active);
        });
    }

    function applyGrid(value) {
        const val = Math.max(1, Math.min(192, parseInt(value, 10)));
        if (isNaN(val)) return;
        noteData.setGrid(val);
        syncGridUI();
        renderer.render();
    }

    const gridInput = document.getElementById('grid-input');
    if (gridInput) {
        gridInput.addEventListener('change', (e) => applyGrid(e.target.value));
        gridInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyGrid(e.target.value); });
    }

    document.querySelectorAll('.grid-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => applyGrid(btn.dataset.grid));
    });

    // 초기 UI 동기화 (기본값 16)
    syncGridUI();

    // 9. 초기 렌더링
    renderer.updateZoomUI();
    renderer.render();

    console.log('Note Editor 초기화 완료');
});
