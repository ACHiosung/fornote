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

        this.isDragging = false;
        this.dragStartAbsSlot = -1;
        this.dragStartLaneName = '';

        this.bindEvents();
    }

    setMode(mode) {
        this.currentMode = mode;
    }

    // 클릭 위치에서 편집 대상 laneName을 결정
    // 모드와 마우스 X 위치의 레인 인덱스 조합으로 결정 (예: long 모드 + laneIdx 4 = 'long_2')
    getTargetLaneName(laneIdx) {
        if (laneIdx < 0 || laneIdx >= 9) return null;
        const laneNum = (laneIdx % 3) + 1;
        if (this.currentMode === 'normal') return 'normal_' + laneNum;
        if (this.currentMode === 'long') return 'long_' + laneNum;
        if (this.currentMode === 'drag') return 'drag_' + laneNum;
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

            // 박자 변화 레인 – 클릭으로 추가/삭제
            if (info.laneName === 'ts_change') {
                let { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(info.absSlot);
                if (this.currentMode === 'delete') {
                    this.noteData.removeTsChange(measureIndex, slotIndex);
                } else {
                    const existing = this.noteData.tsChanges.find(
                        c => c.measureIndex === measureIndex && c.slotIndex === slotIndex
                    );
                    if (existing) {
                        // 같은 위치 재클릭 → 삭제
                        this.noteData.removeTsChange(measureIndex, slotIndex);
                    } else {
                        const input = window.prompt('박자 변경 입력 (예: 3/4, 2/4)', '3/4');
                        if (!input) return;
                        const parts = input.trim().split('/');
                        const num = parseInt(parts[0], 10);
                        const den = parseInt(parts[1], 10);
                        if (parts.length !== 2 || isNaN(num) || isNaN(den) || num <= 0 || den <= 0) {
                            alert('올바른 박자 형식이 아닙니다. (예: 3/4)');
                            return;
                        }
                        this.noteData.addTsChange(measureIndex, slotIndex, num, den);
                    }
                }
                this.renderer.render();
                return;
            }

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
            const targetLane = this.getTargetLaneName(info.laneIdx);
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
