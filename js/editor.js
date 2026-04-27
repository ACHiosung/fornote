/**
 * Editor - 캔버스 클릭/드래그, 모드 전환 관리
 */

class Editor {
    constructor(canvasId, noteData, renderer) {
        this.canvas = document.getElementById(canvasId);
        this.noteData = noteData;
        this.renderer = renderer;

        // 상태 변수
        this.currentMode = 'normal';   // normal, long, drag, delete
        this.currentLaneIndex = 1;     // 1, 2, 3

        this.isDragging = false;
        this.dragStartAbsSlot = -1;
        this.dragStartLaneName = '';

        this.bindEvents();
    }

    setMode(mode) {
        this.currentMode = mode;
    }

    setLane(laneIdx) {
        this.currentLaneIndex = laneIdx;
    }

    // 클릭 위치에서 편집 대상 laneName을 결정
    // 모드와 레인 번호 조합으로 결정 (예: long 모드 + lane 2 = 'long_2')
    getTargetLaneName() {
        if (this.currentMode === 'normal') return 'normal_' + this.currentLaneIndex;
        if (this.currentMode === 'long') return 'long_' + this.currentLaneIndex;
        if (this.currentMode === 'drag') return 'drag_' + this.currentLaneIndex;
        return null; // delete 모드는 클릭한 레인에서 직접 결정
    }

    // 마우스 이벤트 -> laneName, absSlot 변환
    getSlotInfoFromEvent(evt) {
        const rect = this.canvas.getBoundingClientRect();
        const x = evt.clientX - rect.left;
        const y = evt.clientY - rect.top;

        const laneIdx = this.renderer.getLaneFromX(x);
        const absSlot = this.renderer.getSlotFromY(y);

        let laneName = null;
        if (laneIdx >= 0) {
            laneName = this.renderer.laneNames[laneIdx];
        }

        return { laneName, absSlot, laneIdx, y };
    }

    bindEvents() {
        // 스크롤 및 줌
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.ctrlKey || e.shiftKey) {
                let delta = e.deltaY > 0 ? -2 : 2;
                this.renderer.setZoom(delta);
            } else {
                this.renderer.scroll(e.deltaY);
            }
        });

        // 클릭 다운
        this.canvas.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const info = this.getSlotInfoFromEvent(e);
            if (!info.laneName) return;

            // BPM 변화 레인은 읽기 전용 – 편집 불가
            if (info.laneName === 'bpm_change') return;

            // 지우개 모드
            if (this.currentMode === 'delete') {
                let { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(info.absSlot);
                this.noteData.setSlot(info.laneName, measureIndex, slotIndex, '0');
                this.isDragging = true;
                this.dragStartAbsSlot = info.absSlot;
                this.dragStartLaneName = info.laneName;
                this.renderer.render();
                return;
            }

            // 모드에 맞는 레인 결정
            const targetLane = this.getTargetLaneName();
            if (!targetLane) return;

            // 일반노트 모드 → 토글
            if (this.currentMode === 'normal') {
                let { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(info.absSlot);
                this.noteData.toggleSlot(targetLane, measureIndex, slotIndex);
                this.renderer.render();
            } 
            // 롱/드래그노트 모드 → 범위 시작
            else if (this.currentMode === 'long' || this.currentMode === 'drag') {
                this.isDragging = true;
                this.dragStartAbsSlot = info.absSlot;
                this.dragStartLaneName = targetLane;
            }
        });

        // 마우스 무브
        this.canvas.addEventListener('mousemove', (e) => {
            const info = this.getSlotInfoFromEvent(e);
            
            // 정보 패널 업데이트
            const infoLabel = document.getElementById('mouse-info');
            if (info.laneName && info.absSlot >= 0) {
                let { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(info.absSlot);
                infoLabel.innerText = `Lane: ${info.laneName}\nMeasure: #${measureIndex}\nSlot: ${slotIndex}`;
            } else {
                infoLabel.innerText = '-';
            }

            if (this.isDragging) {
                // 롱/드래그 모드 드래그 중
                if ((this.currentMode === 'long' || this.currentMode === 'drag') && this.dragStartLaneName) {
                    this.noteData.setRange(this.dragStartLaneName, this.dragStartAbsSlot, info.absSlot, '1');
                    this.renderer.render();
                }
                
                // 지우개 모드
                if (this.currentMode === 'delete' && this.dragStartLaneName) {
                    this.noteData.setRange(this.dragStartLaneName, this.dragStartAbsSlot, info.absSlot, '0');
                    this.renderer.render();
                }
            }
        });

        // 드래그 종료
        window.addEventListener('mouseup', () => {
            if (this.isDragging) {
                this.isDragging = false;
                this.renderer.render();
            }
        });
    }
}
