/**
 * GridRenderer - Canvas 기반의 에디터 그리드 및 노트 렌더링
 */

class GridRenderer {
    constructor(canvasId, noteData) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.noteData = noteData;

        this.width = 800;
        this.height = 600;
        this.dpr = window.devicePixelRatio || 1;

        // 표시 열: normal/long 통합 lane_N, drag, bpm, ts
        this.laneNames = [
            'lane_1', 'lane_2', 'lane_3',
            'drag_1', 'drag_2', 'drag_3',
            'bpm_change',
            'ts_change',
        ];
        this.laneWidth = 60;
        this.measureLabelWidth = 60;
        this.defaultMeasureHeight = 480; // 기본 마디당 픽셀 높이 (30px × 16분 기준)
        this.measureHeight = 480;        // 마디당 픽셀 높이 (zoom의 primary 값)
        this.scrollY = 0;

        /** 재생 커서 위치 (절대 슬롯, 소수 허용). null이면 미표시 */
        this.playbackCursorAbsSlot = null;

        /** 렌더 완료 후 호출되는 콜백 (편집 모드 오버레이 등에 사용) */
        this.postRenderCallback = null;

        this.init();
    }

    // 재생 커서 위치 설정 (Player에서 호출)
    setPlaybackCursor(absSlot) {
        this.playbackCursorAbsSlot = absSlot;
    }

    init() {
        this._doResize();
        window.addEventListener('resize', () => this._doResize());
    }

    _doResize() {
        const container = this.canvas.parentElement;
        this.width = container.clientWidth;
        this.height = container.clientHeight;
        if (this.width <= 0 || this.height <= 0) return;

        this.dpr = window.devicePixelRatio || 1;
        this.canvas.width = this.width * this.dpr;
        this.canvas.height = this.height * this.dpr;
        this.canvas.style.width = `${this.width}px`;
        this.canvas.style.height = `${this.height}px`;

        this.render();
    }

    // slotHeight는 measureHeight / spm으로 자동 계산 (spm 변화에 무관하게 마디 높이 일정)
    get slotHeight() {
        const spm = this.noteData.slotsPerMeasure;
        return spm > 0 ? this.measureHeight / spm : this.measureHeight;
    }

    setZoom(delta) {
        // delta는 슬롯 단위 (4px)이지만, measureHeight 단위로 환산 (기본 슬롯 16개 기준)
        const step = delta * (this.defaultMeasureHeight / 30); // 30px = 기본 slotHeight
        this.measureHeight += step;
        if (this.measureHeight < 20) this.measureHeight = 20;
        if (this.measureHeight > 60000) this.measureHeight = 60000;
        this.updateZoomUI();
        this.render();
    }

    setSlotHeight(h) {
        // 외부 호환용 — slotHeight 단위를 measureHeight로 환산
        this.measureHeight = h * this.noteData.slotsPerMeasure;
        if (this.measureHeight < 20) this.measureHeight = 20;
        if (this.measureHeight > 60000) this.measureHeight = 60000;
        this.updateZoomUI();
        this.render();
    }

    // 전체 마디를 화면에 맞추기
    zoomFit() {
        const totalMeasures = this.noteData.totalMeasures;
        if (totalMeasures <= 0) return;
        this.measureHeight = Math.max(20, this.height / totalMeasures);
        this.scrollY = 0;
        this.updateZoomUI();
        this.render();
    }

    getZoomPercent() {
        return Math.round((this.measureHeight / this.defaultMeasureHeight) * 100);
    }

    updateZoomUI() {
        const el = document.getElementById('zoom-level');
        if (el) el.textContent = this.getZoomPercent() + '%';
    }

    scroll(delta) {
        this.scrollY += delta;
        if (this.scrollY < 0) this.scrollY = 0;
        const totalHeight = this.noteData.totalMeasures * this.measureHeight;
        if (this.scrollY > totalHeight) this.scrollY = totalHeight;
        this.render();
    }

    // 특정 마디로 스크롤 (화면 중앙에 표시)
    scrollToMeasure(measureIndex) {
        const absSlot = this.noteData.getAbsoluteSlotIndex(measureIndex, 0);
        const targetY = absSlot * this.slotHeight;
        // 해당 마디가 화면 하단 1/3 지점에 오도록
        this.scrollY = targetY - this.height * 0.3;
        if (this.scrollY < 0) this.scrollY = 0;
        this.render();
    }

    getY(measureIndex, slotIndex) {
        const absSlot = this.noteData.getAbsoluteSlotIndex(measureIndex, slotIndex);
        const absoluteY = absSlot * this.slotHeight;
        return this.height - (absoluteY - this.scrollY);
    }

    getSlotFromY(y) {
        const absoluteY = this.height - y + this.scrollY;
        const rawAbsSlot = absoluteY / this.slotHeight;

        // 스냅 간격 = slotsPerMeasure / activeGrid
        const spm = this.noteData.slotsPerMeasure;
        const grid = this.noteData.activeGrid || spm;
        const snapInterval = Math.max(1, Math.round(spm / grid));
        let absSlot = Math.round(rawAbsSlot / snapInterval) * snapInterval;
        if (absSlot < 0) absSlot = 0;
        return absSlot;
    }

    getLaneFromX(x) {
        const startX = this.getGridStartX();
        if (x < startX) return -1;
        const laneIndex = Math.floor((x - startX) / this.laneWidth);
        if (laneIndex >= 0 && laneIndex < this.laneNames.length) return laneIndex;
        return -1;
    }

    getGridStartX() {
        return Math.floor((this.width - (this.laneNames.length * this.laneWidth + this.measureLabelWidth)) / 2);
    }

    render() {
        const ctx = this.ctx;
        const dpr = this.dpr;

        // 변환 초기화 & 클리어
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);

        const gridStartX = this.getGridStartX();
        const gridEndX = gridStartX + (this.laneNames.length * this.laneWidth);

        // ===== 1. 그리드 가로선 =====
        const spm = this.noteData.slotsPerMeasure;
        const spb = this.noteData.slotsPerBeat;  // 1박당 슬롯 (박 선 표시용)

        // 활성 그리드 스냅 간격 (분할선 표시용)
        const grid = this.noteData.activeGrid || spm;
        const snapInterval = Math.max(1, Math.round(spm / grid));

        ctx.lineWidth = 1;
        for (let m = 1; m <= this.noteData.totalMeasures; m++) {
            for (let s = 0; s < spm; s++) {
                const y = this.getY(m, s);
                if (y < -50 || y > this.height + 50) continue;

                const isMeasureLine = (s === 0);
                const isBeatLine = (!isMeasureLine && spb >= 1 && s % spb === 0);
                const isGridSnap = !isMeasureLine && !isBeatLine && (s % snapInterval === 0);

                if (isMeasureLine) {
                    // ── 마디선 (굵은 흰색) ──
                    ctx.strokeStyle = "rgba(255,255,255,0.5)";
                    ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.moveTo(gridStartX, y); ctx.lineTo(gridEndX, y); ctx.stroke();
                    ctx.lineWidth = 1;
                    ctx.fillStyle = "rgba(255,255,255,0.4)";
                    ctx.font = "12px monospace";
                    ctx.textAlign = "right";
                    ctx.fillText(`#${m.toString().padStart(3, '0')}`, gridEndX + this.measureLabelWidth - 10, y + 4);
                } else if (isBeatLine) {
                    // ── 박 선 (중간 밝기) ──
                    ctx.strokeStyle = "rgba(255,255,255,0.25)";
                    ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.moveTo(gridStartX, y); ctx.lineTo(gridEndX, y); ctx.stroke();
                    ctx.lineWidth = 1;
                } else if (isGridSnap) {
                    // ── 현재 그리드 스냅 분할선 (청록색) ──
                    ctx.strokeStyle = "rgba(80,220,200,0.35)";
                    ctx.beginPath(); ctx.moveTo(gridStartX, y); ctx.lineTo(gridEndX, y); ctx.stroke();
                } else {
                    // ── 비스냅 슬롯 (다른 그리드로 배치된 노트 위치 등) ──
                    ctx.strokeStyle = "rgba(255,255,255,0.03)";
                    ctx.beginPath(); ctx.moveTo(gridStartX, y); ctx.lineTo(gridEndX, y); ctx.stroke();
                }
            }
        }

        // ===== 2. 세로선 (Lane 구분) =====
        // 구분선: lane 그룹(0), drag 그룹(3), bpm(6), ts(7), 끝(8)
        for (let i = 0; i <= this.laneNames.length; i++) {
            const x = gridStartX + i * this.laneWidth;
            if (i === 0 || i === 3 || i === 6 || i === 7 || i === 8) {
                ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.4)";
            } else {
                ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,0.15)";
            }
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.height); ctx.stroke();

            if (i < this.laneNames.length) {
                ctx.fillStyle = "rgba(255,255,255,0.6)";
                ctx.font = "10px sans-serif";
                ctx.textAlign = "center";
                const name = this.laneNames[i];
                const disp = name === 'bpm_change' ? 'BPM' :
                             name === 'ts_change'  ? 'TS' :
                             name.startsWith("lane") ? "Ln " + name.split('_')[1] :
                             "Drg " + name.split('_')[1];
                ctx.fillText(disp, x + this.laneWidth / 2, 15);
            }
        }

        // BPM 레인 배경 tint
        const bpmLaneIdx = this.laneNames.indexOf('bpm_change');
        if (bpmLaneIdx >= 0) {
            const bpmX = gridStartX + bpmLaneIdx * this.laneWidth;
            ctx.fillStyle = "rgba(100, 220, 255, 0.04)";
            ctx.fillRect(bpmX, 0, this.laneWidth, this.height);
        }

        // 박자 변화 레인 배경 tint
        const tsLaneIdx = this.laneNames.indexOf('ts_change');
        if (tsLaneIdx >= 0) {
            const tsX = gridStartX + tsLaneIdx * this.laneWidth;
            ctx.fillStyle = "rgba(180, 120, 255, 0.06)";
            ctx.fillRect(tsX, 0, this.laneWidth, this.height);
        }

        // ===== 3. 노트 렌더링 =====
        let drawnCount = 0;

        for (let l = 0; l < this.laneNames.length; l++) {
            const laneName = this.laneNames[l];
            const laneX = gridStartX + l * this.laneWidth;

            // ── BPM 변화 레인 (특수 렌더링, 읽기 전용) ──
            if (laneName === 'bpm_change') {
                for (const change of this.noteData.bpmChanges) {
                    const noteY = this.getY(change.measureIndex, change.slotIndex);
                    if (noteY < -20 || noteY > this.height + 20) continue;

                    const ch = Math.max(4, Math.min(16, this.slotHeight * 0.6));

                    // 마커 바
                    ctx.fillStyle = "rgba(80, 200, 255, 0.85)";
                    ctx.fillRect(laneX + 2, noteY - ch / 2, this.laneWidth - 4, ch);

                    // BPM 수치 텍스트
                    if (ch >= 6) {
                        const fontSize = Math.min(ch - 1, 11);
                        ctx.fillStyle = "#000";
                        ctx.font = `bold ${fontSize}px monospace`;
                        ctx.textAlign = "center";
                        ctx.fillText(`${change.bpm}`, laneX + this.laneWidth / 2, noteY + fontSize / 2 - 1);
                    }
                    drawnCount++;
                }
                continue;
            }

            // ── 박자 변화 레인 (클릭으로 추가/삭제) ──
            if (laneName === 'ts_change') {
                for (const change of this.noteData.tsChanges) {
                    const noteY = this.getY(change.measureIndex, change.slotIndex);
                    if (noteY < -20 || noteY > this.height + 20) continue;

                    const ch = Math.max(4, Math.min(16, this.slotHeight * 0.6));

                    ctx.fillStyle = "rgba(180, 120, 255, 0.85)";
                    ctx.fillRect(laneX + 2, noteY - ch / 2, this.laneWidth - 4, ch);

                    if (ch >= 6) {
                        const fontSize = Math.min(ch - 1, 11);
                        ctx.fillStyle = "#fff";
                        ctx.font = `bold ${fontSize}px monospace`;
                        ctx.textAlign = "center";
                        ctx.fillText(`${change.numerator}/${change.denominator}`, laneX + this.laneWidth / 2, noteY + fontSize / 2 - 1);
                    }
                    drawnCount++;
                }
                continue;
            }

            const type = laneName.split('_')[0];
            const laneNum = laneName.split('_')[1];

            // ── 통합 레인 (lane_N): normal_N 일반 노트 + long_N 롱노트를 한 열에 표시 ──
            if (type === 'lane') {
                const normalLane = 'normal_' + laneNum;
                const longLane   = 'long_'   + laneNum;

                // 롱노트 (green bar) 먼저 그리기
                let isHolding = false;
                let holdStartY = 0;
                for (let m = 1; m <= this.noteData.totalMeasures; m++) {
                    let mData = this.noteData.lanes[longLane][m];
                    if (!mData) continue;
                    for (let s = 0; s < mData.length; s++) {
                        const v = mData[s];
                        if (v !== '1') {
                            if (isHolding) {
                                const prevY = this.getY(m, s);
                                const topY = Math.min(holdStartY, prevY);
                                const h = Math.abs(holdStartY - prevY);
                                ctx.fillStyle = "rgba(0,230,118,0.7)";
                                ctx.fillRect(laneX + 5, topY, this.laneWidth - 10, Math.max(h, 4));
                                isHolding = false;
                                drawnCount++;
                            }
                            continue;
                        }
                        const noteY = this.getY(m, s);
                        if (!isHolding) { isHolding = true; holdStartY = noteY; }
                        let nextIs1 = false;
                        if (s + 1 < mData.length) {
                            nextIs1 = mData[s + 1] === '1';
                        } else if (m + 1 <= this.noteData.totalMeasures) {
                            const nextD = this.noteData.lanes[longLane][m + 1];
                            nextIs1 = nextD && nextD[0] === '1';
                        }
                        if (!nextIs1 && isHolding) {
                            const topY = Math.min(holdStartY, noteY);
                            const h = Math.abs(holdStartY - noteY);
                            ctx.fillStyle = "rgba(0,230,118,0.7)";
                            ctx.fillRect(laneX + 5, topY, this.laneWidth - 10, Math.max(h, 4));
                            isHolding = false;
                            drawnCount++;
                        }
                    }
                }

                // 일반 노트 (pink bar) 위에 그리기
                for (let m = 1; m <= this.noteData.totalMeasures; m++) {
                    let mData = this.noteData.lanes[normalLane][m];
                    if (!mData) continue;
                    for (let s = 0; s < mData.length; s++) {
                        if (mData[s] !== '1') continue;
                        const noteY = this.getY(m, s);
                        if (noteY < -30 || noteY > this.height + 30) continue;
                        ctx.fillStyle = "#ff3366";
                        const ch = Math.max(6, this.slotHeight * 0.4);
                        ctx.fillRect(laneX + 3, noteY - ch / 2, this.laneWidth - 6, ch);
                        drawnCount++;
                    }
                }
                continue;
            }

            let isHolding = false;
            let holdStartY = 0;

            for (let m = 1; m <= this.noteData.totalMeasures; m++) {
                // 직접 lanes 객체에서 데이터 읽기 (getMeasureData 우회 안 함)
                let mData = this.noteData.lanes[laneName][m];
                if (!mData) continue; // 이 마디에 저장된 데이터 없음 → 스킵

                for (let s = 0; s < mData.length; s++) {
                    const v = mData[s];

                    // ── 드래그 노트: 단일 타일 (값 '1' → 노란색, '2' → 빨간색) ──
                    if (type === 'drag') {
                        if (v === '1' || v === '2') {
                            const noteY = this.getY(m, s);
                            if (noteY >= -30 && noteY <= this.height + 30) {
                                ctx.fillStyle = v === '2' ? "#ff2222" : "#ffcc00";
                                const ch = Math.max(6, this.slotHeight * 0.4);
                                ctx.fillRect(laneX + 3, noteY - ch / 2, this.laneWidth - 6, ch);
                                drawnCount++;
                            }
                        }
                        continue;
                    }

                    if (v !== '1') {
                        // 롱노트 연속이 끊기는 지점 처리
                        if (isHolding && type === 'long') {
                            // 이전 슬롯이 끝이었음 → 바 그리기
                            const prevY = this.getY(m, s);
                            const topY = Math.min(holdStartY, prevY);
                            const h = Math.abs(holdStartY - prevY);
                            ctx.fillStyle = "rgba(0,230,118,0.7)";
                            ctx.fillRect(laneX + 5, topY, this.laneWidth - 10, Math.max(h, 4));
                            isHolding = false;
                            drawnCount++;
                        }
                        continue;
                    }

                    // v === '1' 인 경우
                    const noteY = this.getY(m, s);

                    if (type === 'normal') {
                        // 화면 범위 체크
                        if (noteY >= -30 && noteY <= this.height + 30) {
                            ctx.fillStyle = "#ff3366";
                            const ch = Math.max(6, this.slotHeight * 0.4);
                            ctx.fillRect(laneX + 3, noteY - ch / 2, this.laneWidth - 6, ch);
                            drawnCount++;
                        }
                    } else if (type === 'long') {
                        if (!isHolding) {
                            isHolding = true;
                            holdStartY = noteY;
                        }
                        // 마디 끝이면서 다음 마디 첫 슬롯이 이어지지 않으면 바 닫기
                        let nextIs1 = false;
                        if (s + 1 < mData.length) {
                            nextIs1 = mData[s + 1] === '1';
                        } else if (m + 1 <= this.noteData.totalMeasures) {
                            const nextD = this.noteData.lanes[laneName][m + 1];
                            nextIs1 = nextD && nextD[0] === '1';
                        }
                        if (!nextIs1 && isHolding) {
                            const topY = Math.min(holdStartY, noteY);
                            const h = Math.abs(holdStartY - noteY);
                            ctx.fillStyle = "rgba(0,230,118,0.7)";
                            ctx.fillRect(laneX + 5, topY, this.laneWidth - 10, Math.max(h, 4));
                            isHolding = false;
                            drawnCount++;
                        }
                    }
                }
            }
        }

        // ===== 4. 디버그 정보 표시 =====
        let totalNotes = 0;
        const dataLanes = ['normal_1', 'normal_2', 'normal_3', 'long_1', 'long_2', 'long_3', 'drag_1', 'drag_2', 'drag_3'];
        for (const lane of dataLanes) {
            for (let m = 1; m <= this.noteData.totalMeasures; m++) {
                const d = this.noteData.lanes[lane][m];
                if (d) totalNotes += (d.match(/[12]/g) || []).length;
            }
        }
        const bpmChangeCount = this.noteData.bpmChanges.length;
        const tsChangeCount = this.noteData.tsChanges.length;
        ctx.fillStyle = "#fff";
        ctx.font = "12px monospace";
        ctx.textAlign = "left";
        ctx.fillText(`Data: ${totalNotes} notes | BPM changes: ${bpmChangeCount} | TS changes: ${tsChangeCount} | Drawn: ${drawnCount} | Scroll: ${Math.round(this.scrollY)}`, 10, this.height - 8);

        // ===== 5. 재생 커서 =====
        if (this.playbackCursorAbsSlot != null) {
            const absF = this.playbackCursorAbsSlot;
            const absFloor = Math.floor(absF);
            const frac = absF - absFloor;
            const { measureIndex, slotIndex } = this.noteData.getMeasureAndSlotFromAbsolute(absFloor);
            const baseY = this.getY(measureIndex, slotIndex);
            // 슬롯 사이를 보간하여 부드럽게 이동 (y값은 위로 갈수록 감소)
            const cursorY = baseY - frac * this.slotHeight;

            ctx.save();
            ctx.strokeStyle = 'rgba(255, 220, 0, 0.9)';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 3]);
            ctx.beginPath();
            ctx.moveTo(gridStartX, cursorY);
            ctx.lineTo(gridEndX, cursorY);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }

        // ===== 6. postRender 콜백 (편집 모드 선택 오버레이 등) =====
        if (typeof this.postRenderCallback === 'function') {
            this.postRenderCallback();
        }
    }
}
