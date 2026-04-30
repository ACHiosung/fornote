/**
 * Editor - 캔버스 클릭/드래그, 모드 전환 관리
 */

class Editor {
    constructor(canvasId, noteData, renderer) {
        this.canvas = document.getElementById(canvasId);
        this.noteData = noteData;
        this.renderer = renderer;

        // 상태 변수
        this.currentMode = 'write';    // write, delete  (노트 모드 내 서브 모드)
        this.editorMode  = 'note';     // note, edit      (최상위 에디터 모드)

        /** Player 인스턴스 참조 (app.js에서 주입). 재생 중 휠 이동에 사용 */
        this.player = null;

        // ── 노트 모드 드래그 상태 ──
        this.isDragging = false;
        this.dragStartAbsSlot = -1;
        this.dragStartLaneName = '';
        this.dragMoved = false;  // 드래그 이동 여부 (lane_N 통합 레인 클릭 vs 드래그 판별용)

        // ── 편집 모드 드래그 상태 ──
        /**
         * editDrag: {
         *   noteType  : 'normal' | 'long' | 'drag'
         *   srcLaneName : 실제 데이터 레인명 ('normal_1', 'long_2', 'drag_3' 등)
         *   srcLaneNum  : '1' | '2' | '3'
         *   srcLaneIdx  : 렌더러 laneNames 인덱스 (0~5)
         *   srcAbsSlot  : 노트가 있던 absSlot
         *   rangeStart  : (롱노트) 연속 구간 시작 absSlot
         *   rangeEnd    : (롱노트) 연속 구간 끝 absSlot
         *   value       : (드래그 노트) '1' | '2'
         * }
         */
        this.editDrag = null;
        this.editDragCurAbsSlot = -1;  // 현재 마우스 위치의 absSlot (스냅 적용)
        this.editDragCurLaneIdx = -1;  // 현재 마우스 위치의 laneIdx

        // 초기 canvas 클래스 설정
        this.canvas.classList.add('cursor-note');

        this.bindEvents();
    }

    setMode(mode) {
        this.currentMode = mode;
    }

    setEditorMode(mode) {
        this.editorMode = mode;
        this.canvas.classList.remove('cursor-note', 'cursor-edit', 'cursor-edit-grabbing');
        this.canvas.classList.add(mode === 'edit' ? 'cursor-edit' : 'cursor-note');
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

        return { laneName, absSlot, laneIdx, x, y };
    }

    bindEvents() {
        // 스크롤 및 줌
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            // 재생 중 휠: 마디 단위 이동 (위 = 이전 마디, 아래 = 다음 마디)
            if (this.player && this.player.isPlaying) {
                const delta = e.deltaY > 0 ? 1 : -1;
                this.player.seekToMeasure(this.player.getCurrentMeasure() + delta);
                return;
            }
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

            // ────────────── 편집 모드 ──────────────
            if (this.editorMode === 'edit') {
                this._editModeMouseDown(info);
                return;
            }

            // ────────────── 노트 모드 ──────────────

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
                this.isDragging = true;
                this.dragStartAbsSlot = info.absSlot;
                this.dragStartLaneName = info.laneName;
                this.dragMoved = false;
            } else if (laneType === 'drag') {
                let { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(info.absSlot);
                this.noteData.toggleDragSlot(info.laneName, measureIndex, slotIndex);
                this.renderer.render();
            } else if (laneType === 'long') {
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

            // ────────────── 편집 모드 드래그 ──────────────
            if (this.editorMode === 'edit') {
                if (this.editDrag) {
                    this._editModeMouseMove(info);
                }
                return;
            }

            // ────────────── 노트 모드 드래그 ──────────────
            if (this.isDragging) {
                const dragType = this.dragStartLaneName ? this.dragStartLaneName.split('_')[0] : '';

                if (dragType === 'lane' && this.dragStartLaneName) {
                    if (info.absSlot !== this.dragStartAbsSlot) {
                        this.dragMoved = true;
                        const laneNum = this.dragStartLaneName.split('_')[1];
                        this.noteData.setRange('long_' + laneNum, this.dragStartAbsSlot, info.absSlot, '1');
                        this.renderer.render();
                    }
                }

                if (dragType === 'long' && this.dragStartLaneName) {
                    this.noteData.setRange(this.dragStartLaneName, this.dragStartAbsSlot, info.absSlot, '1');
                    this.renderer.render();
                }

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
            // ── 편집 모드 드래그 종료 ──
            if (this.editorMode === 'edit' && this.editDrag) {
                this._editModeMouseUp();
                return;
            }

            // ── 노트 모드 드래그 종료 ──
            if (this.isDragging) {
                const dragType = this.dragStartLaneName ? this.dragStartLaneName.split('_')[0] : '';
                if (dragType === 'lane' && !this.dragMoved && this.currentMode !== 'delete') {
                    const laneNum = this.dragStartLaneName.split('_')[1];
                    const longLane = 'long_' + laneNum;
                    const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(this.dragStartAbsSlot);
                    const mData = this.noteData.getMeasureData(longLane, measureIndex);
                    if (mData && mData[slotIndex] === '1') {
                        const { rangeStart, rangeEnd } = this._getLongNoteRange(longLane, this.dragStartAbsSlot);
                        this.noteData.setRange(longLane, rangeStart, rangeEnd, '0');
                    } else {
                        this.noteData.toggleSlot('normal_' + laneNum, measureIndex, slotIndex);
                    }
                }
                this.isDragging = false;
                this.dragMoved = false;
                this.renderer.render();
            }
        });
    }

    // ═══════════════════════════════════════════════════════
    //  편집 모드 내부 메서드
    // ═══════════════════════════════════════════════════════

    /** mousedown 처리: 클릭 위치에 노트가 있으면 드래그 시작 */
    _editModeMouseDown(info) {
        if (!info.laneName) return;
        const laneType = info.laneName.split('_')[0];

        // bpm_change / ts_change 레인은 편집 모드에서도 무시
        if (info.laneName === 'bpm_change' || info.laneName === 'ts_change') return;

        const laneNum = info.laneName.split('_')[1];
        const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(info.absSlot);

        if (laneType === 'lane') {
            const normalLane = 'normal_' + laneNum;
            const longLane   = 'long_'   + laneNum;
            const normalData = this.noteData.getMeasureData(normalLane, measureIndex);
            const longData   = this.noteData.getMeasureData(longLane,   measureIndex);

            if (normalData && normalData[slotIndex] === '1') {
                // 일반 노트 잡기
                this.editDrag = {
                    noteType:    'normal',
                    srcLaneName: normalLane,
                    srcLaneNum:  laneNum,
                    srcLaneIdx:  info.laneIdx,
                    srcAbsSlot:  info.absSlot,
                };
                this.editDragCurAbsSlot = info.absSlot;
                this.editDragCurLaneIdx = info.laneIdx;
                this._setEditCursor(true);
            } else if (longData && longData[slotIndex] === '1') {
                // 롱노트 잡기
                const { rangeStart, rangeEnd } = this._getLongNoteRange(longLane, info.absSlot);
                this.editDrag = {
                    noteType:    'long',
                    srcLaneName: longLane,
                    srcLaneNum:  laneNum,
                    srcLaneIdx:  info.laneIdx,
                    srcAbsSlot:  info.absSlot,
                    rangeStart,
                    rangeEnd,
                };
                this.editDragCurAbsSlot = info.absSlot;
                this.editDragCurLaneIdx = info.laneIdx;
                this._setEditCursor(true);
            }
        } else if (laneType === 'drag') {
            const dragData = this.noteData.getMeasureData(info.laneName, measureIndex);
            const val = dragData ? dragData[slotIndex] : '0';
            if (val === '1' || val === '2') {
                this.editDrag = {
                    noteType:    'drag',
                    srcLaneName: info.laneName,
                    srcLaneNum:  laneNum,
                    srcLaneIdx:  info.laneIdx,
                    srcAbsSlot:  info.absSlot,
                    value:       val,
                };
                this.editDragCurAbsSlot = info.absSlot;
                this.editDragCurLaneIdx = info.laneIdx;
                this._setEditCursor(true);
            }
        }
    }

    /** mousemove 처리: 드래그 중 ghost 표시 */
    _editModeMouseMove(info) {
        const drag = this.editDrag;
        const srcLaneType = drag.srcLaneName.split('_')[0]; // 'normal','long','drag'
        const isLaneGroup = (srcLaneType === 'normal' || srcLaneType === 'long'); // Ln열

        // ── 레인 인덱스 갱신 (같은 그룹 내에서만 이동 허용) ──
        if (info.laneIdx >= 0 && info.laneName) {
            const targetType = info.laneName.split('_')[0];
            if (isLaneGroup && targetType === 'lane') {
                // Ln 그룹 (laneIdx 0~2) 내에서만
                this.editDragCurLaneIdx = info.laneIdx;
            } else if (!isLaneGroup && targetType === 'drag') {
                // Drg 그룹 (laneIdx 3~5) 내에서만
                this.editDragCurLaneIdx = info.laneIdx;
            }
            // 다른 그룹(bpm/ts/반대 그룹) 진입 시 레인 인덱스 유지
        }

        // ── absSlot 갱신 ──
        // 다른 레인으로 이동 중: 원래 타이밍 유지
        // 같은 레인 내 이동: 마우스 Y 위치의 그리드 스냅 값 사용
        if (this.editDragCurLaneIdx !== drag.srcLaneIdx) {
            this.editDragCurAbsSlot = drag.srcAbsSlot;
        } else {
            if (info.absSlot >= 0) {
                this.editDragCurAbsSlot = info.absSlot;
            }
        }

        this.renderer.render();
        this._drawEditGhost();
    }

    /** mouseup 처리: 이동 확정 */
    _editModeMouseUp() {
        const drag = this.editDrag;
        const newAbsSlot = this.editDragCurAbsSlot;
        const newLaneIdx = this.editDragCurLaneIdx;

        const moved = (newAbsSlot !== drag.srcAbsSlot) || (newLaneIdx !== drag.srcLaneIdx);

        if (moved) {
            const newLaneName = this.renderer.laneNames[newLaneIdx];
            const newLaneNum  = newLaneName ? newLaneName.split('_')[1] : drag.srcLaneNum;

            if (drag.noteType === 'normal') {
                // 원래 위치 삭제
                const { measureIndex: oldM, slotIndex: oldS } =
                    this.noteData.getMeasureAndSlotFromAbsolute(drag.srcAbsSlot);
                this.noteData.setSlot(drag.srcLaneName, oldM, oldS, '0');
                // 새 위치 배치
                const newRealLane = 'normal_' + newLaneNum;
                const { measureIndex: newM, slotIndex: newS } =
                    this.noteData.getMeasureAndSlotFromAbsolute(newAbsSlot);
                this.noteData.setSlot(newRealLane, newM, newS, '1');

            } else if (drag.noteType === 'long') {
                const delta    = newAbsSlot - drag.srcAbsSlot;
                const newStart = drag.rangeStart + delta;
                const newEnd   = drag.rangeEnd   + delta;
                // 원래 범위 삭제
                this.noteData.setRange(drag.srcLaneName, drag.rangeStart, drag.rangeEnd, '0');
                // 새 범위 배치
                const newRealLane = 'long_' + newLaneNum;
                if (newStart >= 0) {
                    this.noteData.setRange(newRealLane, newStart, newEnd, '1');
                }

            } else if (drag.noteType === 'drag') {
                // 원래 위치 삭제
                const { measureIndex: oldM, slotIndex: oldS } =
                    this.noteData.getMeasureAndSlotFromAbsolute(drag.srcAbsSlot);
                this.noteData.setSlot(drag.srcLaneName, oldM, oldS, '0');
                // 새 위치 배치 (값 보존)
                const newRealLane = 'drag_' + newLaneNum;
                const { measureIndex: newM, slotIndex: newS } =
                    this.noteData.getMeasureAndSlotFromAbsolute(newAbsSlot);
                this.noteData.setSlot(newRealLane, newM, newS, drag.value);
            }
        }

        this.editDrag = null;
        this.editDragCurAbsSlot = -1;
        this.editDragCurLaneIdx = -1;
        this._setEditCursor(false);
        this.renderer.render();
    }

    /** 편집 모드에서 ghost note 오버레이 그리기 */
    _drawEditGhost() {
        const drag = this.editDrag;
        if (!drag) return;

        const ctx  = this.renderer.ctx;
        const dpr  = this.renderer.dpr;
        const laneW = this.renderer.laneWidth;
        const gridStartX = this.renderer.getGridStartX();

        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // 원래 노트 위치에 반투명 어두운 마스크 (드래그 중임을 표시)
        const srcX = gridStartX + drag.srcLaneIdx * laneW;

        if (drag.noteType === 'normal') {
            this._ghostDimNormal(ctx, srcX, drag.srcAbsSlot, laneW, 'rgba(0,0,0,0.55)');
        } else if (drag.noteType === 'long') {
            this._ghostDimLong(ctx, srcX, drag.rangeStart, drag.rangeEnd, laneW, 'rgba(0,0,0,0.55)');
        } else if (drag.noteType === 'drag') {
            this._ghostDimNormal(ctx, srcX, drag.srcAbsSlot, laneW, 'rgba(0,0,0,0.55)');
        }

        // 새 위치에 ghost 노트
        const dstX = gridStartX + this.editDragCurLaneIdx * laneW;

        if (drag.noteType === 'normal') {
            this._ghostDimNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, 'rgba(255,51,102,0.55)');
            this._ghostOutlineNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, 'rgba(255,51,102,1)');
        } else if (drag.noteType === 'long') {
            const delta    = this.editDragCurAbsSlot - drag.srcAbsSlot;
            const newStart = drag.rangeStart + delta;
            const newEnd   = drag.rangeEnd   + delta;
            this._ghostDimLong(ctx, dstX, newStart, newEnd, laneW, 'rgba(0,230,118,0.45)');
            this._ghostOutlineLong(ctx, dstX, newStart, newEnd, laneW, 'rgba(0,230,118,1)');
        } else if (drag.noteType === 'drag') {
            const ghostColor = drag.value === '2' ? 'rgba(255,34,34,0.55)' : 'rgba(255,204,0,0.55)';
            const outlineColor = drag.value === '2' ? 'rgba(255,34,34,1)' : 'rgba(255,204,0,1)';
            this._ghostDimNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, ghostColor);
            this._ghostOutlineNormal(ctx, dstX, this.editDragCurAbsSlot, laneW, outlineColor);
        }

        ctx.restore();
    }

    // ── ghost 헬퍼 ──

    _noteBarHeight() {
        return Math.max(6, this.renderer.slotHeight * 0.4);
    }

    _ghostDimNormal(ctx, laneX, absSlot, laneW, fillStyle) {
        const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(absSlot);
        const noteY = this.renderer.getY(measureIndex, slotIndex);
        const ch = this._noteBarHeight();
        ctx.fillStyle = fillStyle;
        ctx.fillRect(laneX + 3, noteY - ch / 2, laneW - 6, ch);
    }

    _ghostOutlineNormal(ctx, laneX, absSlot, laneW, strokeStyle) {
        const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(absSlot);
        const noteY = this.renderer.getY(measureIndex, slotIndex);
        const ch = this._noteBarHeight();
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(laneX + 3, noteY - ch / 2, laneW - 6, ch);
    }

    _ghostDimLong(ctx, laneX, absStart, absEnd, laneW, fillStyle) {
        const start = Math.min(absStart, absEnd);
        const end   = Math.max(absStart, absEnd);
        const { measureIndex: m1, slotIndex: s1 } = this.noteData.getMeasureAndSlotFromAbsolute(start);
        const { measureIndex: m2, slotIndex: s2 } = this.noteData.getMeasureAndSlotFromAbsolute(end);
        const y1 = this.renderer.getY(m1, s1);
        const y2 = this.renderer.getY(m2, s2);
        const topY = Math.min(y1, y2);
        const h    = Math.max(Math.abs(y1 - y2), 4);
        ctx.fillStyle = fillStyle;
        ctx.fillRect(laneX + 5, topY, laneW - 10, h);
    }

    _ghostOutlineLong(ctx, laneX, absStart, absEnd, laneW, strokeStyle) {
        const start = Math.min(absStart, absEnd);
        const end   = Math.max(absStart, absEnd);
        const { measureIndex: m1, slotIndex: s1 } = this.noteData.getMeasureAndSlotFromAbsolute(start);
        const { measureIndex: m2, slotIndex: s2 } = this.noteData.getMeasureAndSlotFromAbsolute(end);
        const y1 = this.renderer.getY(m1, s1);
        const y2 = this.renderer.getY(m2, s2);
        const topY = Math.min(y1, y2);
        const h    = Math.max(Math.abs(y1 - y2), 4);
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(laneX + 5, topY, laneW - 10, h);
    }

    _setEditCursor(grabbing) {
        this.canvas.classList.remove('cursor-edit', 'cursor-edit-grabbing');
        this.canvas.classList.add(grabbing ? 'cursor-edit-grabbing' : 'cursor-edit');
    }

    // ═══════════════════════════════════════════════════════
    //  공통 헬퍼
    // ═══════════════════════════════════════════════════════

    // 특정 absSlot에서 연결된 롱노트 범위(연속 '1') 의 시작/끝 absSlot 반환
    _getLongNoteRange(longLaneName, absSlot) {
        const totalSlots = this.noteData.totalMeasures * this.noteData.slotsPerMeasure;
        const getVal = (i) => {
            if (i < 0 || i >= totalSlots) return '0';
            const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(i);
            const d = this.noteData.getMeasureData(longLaneName, measureIndex);
            return d ? d[slotIndex] : '0';
        };

        let start = absSlot;
        while (start > 0 && getVal(start - 1) === '1') start--;
        let end = absSlot;
        while (end < totalSlots - 1 && getVal(end + 1) === '1') end++;

        return { rangeStart: start, rangeEnd: end };
    }
}
