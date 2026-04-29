/**
 * Editor - 캔버스 클릭/드래그, 모드 전환 관리
 */

class Editor {
    constructor(canvasId, noteData, renderer) {
        this.canvas = document.getElementById(canvasId);
        this.noteData = noteData;
        this.renderer = renderer;

        // 상태 변수
        this.currentMode = 'write';    // write, delete

        this.isDragging = false;
        this.dragStartAbsSlot = -1;
        this.dragStartLaneName = '';
        this.dragMoved = false;  // 드래그 이동 여부 (lane_N 통합 레인 클릭 vs 드래그 판별용)

        this.bindEvents();
    }

    setMode(mode) {
        this.currentMode = mode;
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
                const laneType = info.laneName.split('_')[0];
                if (laneType === 'lane') {
                    // 통합 레인: normal_N 과 long_N 모두 지우기
                    const laneNum = info.laneName.split('_')[1];
                    this.noteData.setSlot('normal_' + laneNum, measureIndex, slotIndex, '0');
                    this.noteData.setSlot('long_'   + laneNum, measureIndex, slotIndex, '0');
                } else {
                    this.noteData.setSlot(info.laneName, measureIndex, slotIndex, '0');
                }
                this.isDragging = true;
                this.dragStartAbsSlot = info.absSlot;
                this.dragStartLaneName = info.laneName;
                this.renderer.render();
                return;
            }

            // 쓰기 모드: 레인 이름에서 노트 타입 결정
            const laneType = info.laneName.split('_')[0]; // 'lane', 'drag'

            if (laneType === 'lane') {
                // 통합 레인: 드래그 여부를 mouseup 시점에 판별하므로 일단 기록만
                this.isDragging = true;
                this.dragStartAbsSlot = info.absSlot;
                this.dragStartLaneName = info.laneName;
                this.dragMoved = false;
            } else if (laneType === 'drag') {
                // 드래그 노트 → 토글 (0 ↔ 2), 빨간 단일 노트
                let { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(info.absSlot);
                this.noteData.toggleDragSlot(info.laneName, measureIndex, slotIndex);
                this.renderer.render();
            } else if (laneType === 'long') {
                // 롱노트 → 범위 드래그 시작 (직접 롱 레인에 접근하는 경우 대비, 현재 UI에서는 미사용)
                this.isDragging = true;
                this.dragStartAbsSlot = info.absSlot;
                this.dragStartLaneName = info.laneName;
                this.dragMoved = false;
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
                const dragType = this.dragStartLaneName ? this.dragStartLaneName.split('_')[0] : '';

                // 통합 레인 롱노트 범위 드래그
                if (dragType === 'lane' && this.dragStartLaneName) {
                    if (info.absSlot !== this.dragStartAbsSlot) {
                        this.dragMoved = true;
                        const laneNum = this.dragStartLaneName.split('_')[1];
                        this.noteData.setRange('long_' + laneNum, this.dragStartAbsSlot, info.absSlot, '1');
                        this.renderer.render();
                    }
                }

                // 롱노트 범위 드래그 (직접 롱 레인)
                if (dragType === 'long' && this.dragStartLaneName) {
                    this.noteData.setRange(this.dragStartLaneName, this.dragStartAbsSlot, info.absSlot, '1');
                    this.renderer.render();
                }

                // 지우개 모드
                if (this.currentMode === 'delete' && this.dragStartLaneName) {
                    const delType = this.dragStartLaneName.split('_')[0];
                    if (delType === 'lane') {
                        const laneNum = this.dragStartLaneName.split('_')[1];
                        this.noteData.setRange('normal_' + laneNum, this.dragStartAbsSlot, info.absSlot, '0');
                        this.noteData.setRange('long_'   + laneNum, this.dragStartAbsSlot, info.absSlot, '0');
                    } else {
                        this.noteData.setRange(this.dragStartLaneName, this.dragStartAbsSlot, info.absSlot, '0');
                    }
                    this.renderer.render();
                }
            }
        });

        // 드래그 종료
        window.addEventListener('mouseup', () => {
            if (this.isDragging) {
                const dragType = this.dragStartLaneName ? this.dragStartLaneName.split('_')[0] : '';
                // 통합 레인에서 드래그 없이 뗀 경우 → 일반 노트 토글
                if (dragType === 'lane' && !this.dragMoved && this.currentMode !== 'delete') {
                    const laneNum = this.dragStartLaneName.split('_')[1];
                    let { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(this.dragStartAbsSlot);
                    this.noteData.toggleSlot('normal_' + laneNum, measureIndex, slotIndex);
                }
                this.isDragging = false;
                this.dragMoved = false;
                this.renderer.render();
            }
        });
    }
}
