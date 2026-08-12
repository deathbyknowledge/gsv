use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    point, px, quad, AnyElement, App, BorderStyle, Bounds, CursorStyle, Edges, Element, ElementId,
    Empty, GlobalElementId, HighlightStyle, Hitbox, HitboxBehavior, InspectorElementId,
    IntoElement, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels,
    Point, SharedString, StyledText, TextLayout, Window,
};

use crate::theme;

#[derive(Clone, Default)]
pub(super) struct TextSelection {
    inner: Rc<RefCell<TextSelectionState>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SelectionTopology {
    PlainMessage,
    RichDocument,
    PlainPrefixWithRichDocument,
    TerminalTranscript,
}

#[derive(Default)]
struct TextSelectionState {
    content_key: String,
    topology: Option<SelectionTopology>,
    anchor: Option<DocumentPosition>,
    head: Option<DocumentPosition>,
    drag_origin: Option<Point<Pixels>>,
    dragged: bool,
    selecting: bool,
    fragments: BTreeMap<u32, RegisteredFragment>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct DocumentPosition {
    order: u32,
    offset: usize,
}

struct RegisteredFragment {
    text: SharedString,
    separator_before: SharedString,
    layout: TextLayout,
}

impl TextSelection {
    pub(super) fn prepare(&self, content_key: impl Into<String>, topology: SelectionTopology) {
        let content_key = content_key.into();
        let mut state = self.inner.borrow_mut();
        if state.content_key != content_key || state.topology != Some(topology) {
            state.content_key = content_key;
            state.topology = Some(topology);
            state.anchor = None;
            state.head = None;
            state.drag_origin = None;
            state.dragged = false;
            state.selecting = false;
        }
        state.fragments.clear();
    }

    pub(super) fn clear(&self) -> bool {
        let mut state = self.inner.borrow_mut();
        let changed = state.anchor.is_some()
            || state.head.is_some()
            || state.drag_origin.is_some()
            || state.dragged
            || state.selecting;
        state.anchor = None;
        state.head = None;
        state.drag_origin = None;
        state.dragged = false;
        state.selecting = false;
        state.fragments.clear();
        changed
    }

    pub(super) fn selected_text(&self) -> Option<String> {
        let state = self.inner.borrow();
        selected_text(&state.fragments, state.anchor?, state.head?)
    }

    fn start(&self, position: Point<Pixels>) {
        let mut state = self.inner.borrow_mut();
        let document_position = document_position_for_point(&state.fragments, position);
        state.anchor = document_position;
        state.head = document_position;
        state.drag_origin = Some(position);
        state.dragged = false;
        state.selecting = document_position.is_some();
    }

    fn update(&self, position: Point<Pixels>) {
        let mut state = self.inner.borrow_mut();
        if state.selecting {
            state.dragged |= state.drag_origin.is_some_and(|origin| origin != position);
            if let Some(document_position) = document_position_for_point(&state.fragments, position)
            {
                state.head = Some(document_position);
            }
        }
    }

    fn finish(&self, position: Point<Pixels>) {
        let mut state = self.inner.borrow_mut();
        if state.selecting {
            state.dragged |= state.drag_origin.is_some_and(|origin| origin != position);
            if let Some(document_position) = document_position_for_point(&state.fragments, position)
            {
                state.head = Some(document_position);
            }
            state.selecting = false;
        }
        state.drag_origin = None;
    }

    fn is_selecting(&self) -> bool {
        self.inner.borrow().selecting
    }

    fn is_click_at(&self, position: Point<Pixels>) -> bool {
        let state = self.inner.borrow();
        !state.dragged && state.drag_origin.is_none_or(|origin| origin == position)
    }

    fn register_fragment(
        &self,
        order: u32,
        text: SharedString,
        separator_before: SharedString,
        layout: TextLayout,
    ) {
        self.inner.borrow_mut().fragments.insert(
            order,
            RegisteredFragment {
                text,
                separator_before,
                layout,
            },
        );
    }

    fn range_for_fragment(&self, order: u32, text: &str) -> Option<Range<usize>> {
        let state = self.inner.borrow();
        selection_range(state.anchor?, state.head?, order, text)
    }
}

fn ordered_positions(
    anchor: DocumentPosition,
    head: DocumentPosition,
) -> Option<(DocumentPosition, DocumentPosition)> {
    (anchor != head).then_some(if anchor < head {
        (anchor, head)
    } else {
        (head, anchor)
    })
}

fn selection_range(
    anchor: DocumentPosition,
    head: DocumentPosition,
    order: u32,
    text: &str,
) -> Option<Range<usize>> {
    let (start, end) = ordered_positions(anchor, head)?;
    if order < start.order || order > end.order {
        return None;
    }

    let start_offset = if order == start.order {
        clamp_to_char_boundary(text, start.offset)
    } else {
        0
    };
    let end_offset = if order == end.order {
        clamp_to_char_boundary(text, end.offset)
    } else {
        text.len()
    };
    (start_offset < end_offset).then_some(start_offset..end_offset)
}

fn selected_text(
    fragments: &BTreeMap<u32, RegisteredFragment>,
    anchor: DocumentPosition,
    head: DocumentPosition,
) -> Option<String> {
    let (start, end) = ordered_positions(anchor, head)?;
    let mut document = String::new();
    let mut start_offset = None;
    let mut end_offset = None;

    for (index, (order, fragment)) in fragments.iter().enumerate() {
        if index > 0 {
            document.push_str(&fragment.separator_before);
        }
        let fragment_start = document.len();
        if *order == start.order {
            start_offset =
                Some(fragment_start + clamp_to_char_boundary(&fragment.text, start.offset));
        }
        if *order == end.order {
            end_offset = Some(fragment_start + clamp_to_char_boundary(&fragment.text, end.offset));
        }
        document.push_str(&fragment.text);
    }

    document
        .get(start_offset?..end_offset?)
        .filter(|selected| !selected.is_empty())
        .map(str::to_owned)
}

fn document_position_for_point(
    fragments: &BTreeMap<u32, RegisteredFragment>,
    position: Point<Pixels>,
) -> Option<DocumentPosition> {
    let (order, fragment) = fragments.iter().min_by(|(_, left), (_, right)| {
        distance_to_bounds(position, left.layout.bounds())
            .total_cmp(&distance_to_bounds(position, right.layout.bounds()))
    })?;
    let offset = fragment
        .layout
        .index_for_position(position)
        .unwrap_or_else(|offset| offset);
    Some(DocumentPosition {
        order: *order,
        offset: clamp_to_char_boundary(&fragment.text, offset),
    })
}

fn distance_to_bounds(position: Point<Pixels>, bounds: Bounds<Pixels>) -> f32 {
    let x = f32::from(position.x);
    let y = f32::from(position.y);
    let left = f32::from(bounds.left());
    let right = f32::from(bounds.right());
    let top = f32::from(bounds.top());
    let bottom = f32::from(bounds.bottom());
    let dx = if x < left {
        left - x
    } else if x > right {
        x - right
    } else {
        0.0
    };
    let dy = if y < top {
        top - y
    } else if y > bottom {
        y - bottom
    } else {
        0.0
    };
    dx.mul_add(dx, dy * dy)
}

fn clamp_to_char_boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

pub(super) struct SelectionSurface {
    id: ElementId,
    selection: TextSelection,
    child: AnyElement,
}

impl SelectionSurface {
    pub(super) fn new(
        id: impl Into<ElementId>,
        selection: TextSelection,
        child: impl IntoElement,
    ) -> Self {
        Self {
            id: id.into(),
            selection,
            child: child.into_any_element(),
        }
    }
}

impl IntoElement for SelectionSurface {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for SelectionSurface {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut child = std::mem::replace(&mut self.child, Empty.into_any_element());
        let layout_id = child.request_layout(window, cx);
        (layout_id, child)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child: &mut Self::RequestLayoutState,
        _: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        child.paint(window, cx);

        let current_view = window.current_view();
        let selection = self.selection.clone();
        window.on_mouse_event(move |event: &MouseDownEvent, phase, _, cx| {
            if event.button != MouseButton::Left
                || !phase.bubble()
                || !bounds.contains(&event.position)
            {
                return;
            }
            selection.start(event.position);
            cx.notify(current_view);
        });

        if self.selection.is_selecting() {
            let selection = self.selection.clone();
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                if !phase.bubble() {
                    return;
                }
                selection.update(event.position);
                cx.notify(current_view);
            });

            let selection = self.selection.clone();
            window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                if event.button != MouseButton::Left || !phase.bubble() {
                    return;
                }
                selection.finish(event.position);
                cx.notify(current_view);
            });
        }
    }
}

pub(super) struct SelectableText {
    id: ElementId,
    selection: TextSelection,
    order: u32,
    separator_before: SharedString,
    text: SharedString,
    highlights: Vec<(Range<usize>, HighlightStyle)>,
    links: Rc<Vec<(Range<usize>, String)>>,
    styled_text: StyledText,
}

impl SelectableText {
    pub(super) fn new(
        id: impl Into<SharedString>,
        selection: TextSelection,
        order: u32,
        text: impl Into<SharedString>,
    ) -> Self {
        let text = text.into();
        Self {
            id: ElementId::Name(id.into()),
            selection,
            order,
            separator_before: "\n\n".into(),
            highlights: Vec::new(),
            links: Rc::new(Vec::new()),
            styled_text: StyledText::new(text.clone()),
            text,
        }
    }

    pub(super) fn separator_before(mut self, separator: impl Into<SharedString>) -> Self {
        self.separator_before = separator.into();
        self
    }

    pub(super) fn highlights(mut self, highlights: Vec<(Range<usize>, HighlightStyle)>) -> Self {
        self.highlights = highlights;
        self
    }

    pub(super) fn links(mut self, links: Vec<(Range<usize>, String)>) -> Self {
        self.links = Rc::new(links);
        self
    }

    fn link_for_position(&self, layout: &TextLayout, position: Point<Pixels>) -> Option<String> {
        let offset = layout.index_for_position(position).ok()?;
        self.links
            .iter()
            .find(|(range, _)| range.contains(&offset))
            .map(|(_, url)| url.clone())
    }
}

impl IntoElement for SelectableText {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for SelectableText {
    type RequestLayoutState = ();
    type PrepaintState = Hitbox;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        global_element_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let text_style = window.text_style();
        let mut runs = Vec::new();
        let mut offset = 0;
        for (range, highlight) in &self.highlights {
            if offset < range.start {
                runs.push(text_style.clone().to_run(range.start - offset));
            }
            runs.push(text_style.clone().highlight(*highlight).to_run(range.len()));
            offset = range.end;
        }
        if offset < self.text.len() {
            runs.push(text_style.to_run(self.text.len() - offset));
        }
        self.styled_text = StyledText::new(self.text.clone()).with_runs(runs);
        let (layout_id, _) =
            self.styled_text
                .request_layout(global_element_id, inspector_id, window, cx);
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.styled_text
            .prepaint(id, inspector_id, bounds, &mut (), window, cx);
        window.insert_hitbox(bounds, HitboxBehavior::Normal)
    }

    fn paint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        hitbox: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let layout = self.styled_text.layout().clone();
        self.selection.register_fragment(
            self.order,
            self.text.clone(),
            self.separator_before.clone(),
            layout.clone(),
        );
        let selected = self.selection.range_for_fragment(self.order, &self.text);
        if let Some(range) = &selected {
            paint_selection(range, &layout, bounds, window);
        }
        self.styled_text
            .paint(global_id, None, bounds, &mut (), &mut (), window, cx);

        window.set_cursor_style(CursorStyle::IBeam, hitbox);
        let hovered_link = self.link_for_position(&layout, window.mouse_position());
        if hovered_link.is_some() && selected.is_none() {
            window.set_cursor_style(CursorStyle::PointingHand, hitbox);
        }

        let selection = self.selection.clone();
        let links = self.links.clone();
        window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
            if event.button != MouseButton::Left
                || !phase.bubble()
                || !bounds.contains(&event.position)
                || !selection.is_click_at(event.position)
            {
                return;
            }
            let Ok(offset) = layout.index_for_position(event.position) else {
                return;
            };
            if let Some((_, url)) = links.iter().find(|(range, _)| range.contains(&offset)) {
                cx.stop_propagation();
                cx.open_url(url);
            }
        });
    }
}

fn paint_selection(
    range: &Range<usize>,
    layout: &TextLayout,
    bounds: Bounds<Pixels>,
    window: &mut Window,
) {
    let (Some(start), Some(end)) = (
        layout.position_for_index(range.start),
        layout.position_for_index(range.end),
    ) else {
        return;
    };
    let line_height = layout.line_height();
    let color = theme::color(theme::SELECTION).opacity(0.9);
    let paint = |bounds, window: &mut Window| {
        window.paint_quad(quad(
            bounds,
            px(0.0),
            color,
            Edges::default(),
            gpui::transparent_black(),
            BorderStyle::default(),
        ));
    };
    if start.y == end.y {
        paint(
            Bounds::from_corners(start, point(end.x, end.y + line_height)),
            window,
        );
        return;
    }
    paint(
        Bounds::from_corners(start, point(bounds.right(), start.y + line_height)),
        window,
    );
    if end.y > start.y + line_height {
        paint(
            Bounds::from_corners(
                point(bounds.left(), start.y + line_height),
                point(bounds.right(), end.y),
            ),
            window,
        );
    }
    paint(
        Bounds::from_corners(
            point(bounds.left(), end.y),
            point(end.x, end.y + line_height),
        ),
        window,
    );
}

#[cfg(test)]
mod tests {
    use gpui::{
        div, relative, AppContext as _, ClipboardItem, Context, FocusHandle, Focusable,
        InteractiveElement as _, Modifiers, ParentElement as _, Render, Styled, TestAppContext,
        VisualTestContext, WindowOptions,
    };
    use gpui_component::input::Copy;

    use super::*;

    fn fragment(text: &str, separator_before: &str) -> RegisteredFragment {
        RegisteredFragment {
            text: text.to_owned().into(),
            separator_before: separator_before.to_owned().into(),
            layout: TextLayout::default(),
        }
    }

    #[test]
    fn copied_fragments_keep_document_order_and_exact_separators_in_both_directions() {
        let fragments = BTreeMap::from([
            (2, fragment("third", "\n")),
            (0, fragment("first", "ignored")),
            (1, fragment("second", " ")),
        ]);
        let start = DocumentPosition {
            order: 0,
            offset: 1,
        };
        let end = DocumentPosition {
            order: 2,
            offset: 5,
        };

        assert_eq!(
            selected_text(&fragments, start, end).as_deref(),
            Some("irst second\nthird")
        );
        assert_eq!(
            selected_text(&fragments, end, start),
            selected_text(&fragments, start, end)
        );
    }

    #[test]
    fn selection_between_fragment_edges_contains_the_structural_separator() {
        let fragments = BTreeMap::from([(0, fragment("alpha", "")), (1, fragment("beta", "\n\n"))]);

        assert_eq!(
            selected_text(
                &fragments,
                DocumentPosition {
                    order: 0,
                    offset: 5,
                },
                DocumentPosition {
                    order: 1,
                    offset: 0,
                },
            )
            .as_deref(),
            Some("\n\n")
        );
    }

    #[test]
    fn utf8_ranges_and_code_whitespace_are_copied_without_normalization() {
        let fragments = BTreeMap::from([
            (0, fragment("a中🙂z", "")),
            (1, fragment("  let x = 1;\n\t\n", "\n")),
        ]);

        assert_eq!(
            selected_text(
                &fragments,
                DocumentPosition {
                    order: 0,
                    offset: 1,
                },
                DocumentPosition {
                    order: 0,
                    offset: 8,
                },
            )
            .as_deref(),
            Some("中🙂")
        );
        assert_eq!(
            selected_text(
                &fragments,
                DocumentPosition {
                    order: 1,
                    offset: 0,
                },
                DocumentPosition {
                    order: 1,
                    offset: usize::MAX,
                },
            )
            .as_deref(),
            Some("  let x = 1;\n\t\n")
        );
    }

    #[test]
    fn clearing_selection_removes_copy_payload() {
        let selection = TextSelection::default();
        {
            let mut state = selection.inner.borrow_mut();
            state.fragments.insert(0, fragment("copy me", ""));
            state.anchor = Some(DocumentPosition {
                order: 0,
                offset: 0,
            });
            state.head = Some(DocumentPosition {
                order: 0,
                offset: 7,
            });
        }
        assert!(selection.clear());
        assert_eq!(selection.selected_text(), None);
        assert!(!selection.clear());
    }

    #[test]
    fn incompatible_fragment_topology_invalidates_an_existing_selection() {
        let selection = TextSelection::default();
        selection.prepare("same-reply", SelectionTopology::PlainMessage);
        {
            let mut state = selection.inner.borrow_mut();
            state.fragments.insert(0, fragment("same text", ""));
            state.anchor = Some(DocumentPosition {
                order: 0,
                offset: 0,
            });
            state.head = Some(DocumentPosition {
                order: 0,
                offset: 4,
            });
        }
        assert_eq!(selection.selected_text().as_deref(), Some("same"));

        selection.prepare("same-reply", SelectionTopology::RichDocument);

        assert_eq!(selection.selected_text(), None);
        let state = selection.inner.borrow();
        assert!(state.anchor.is_none());
        assert!(state.head.is_none());
    }

    struct SelectionHarness {
        selection: TextSelection,
        focus_handle: FocusHandle,
    }

    impl SelectionHarness {
        fn copy_selection(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
            if let Some(selected) = self.selection.selected_text() {
                cx.write_to_clipboard(ClipboardItem::new_string(selected));
                cx.stop_propagation();
            } else {
                cx.propagate();
            }
        }
    }

    impl Focusable for SelectionHarness {
        fn focus_handle(&self, _: &App) -> FocusHandle {
            self.focus_handle.clone()
        }
    }

    impl Render for SelectionHarness {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            self.selection
                .prepare("selection-harness", SelectionTopology::RichDocument);
            div()
                .size_full()
                .track_focus(&self.focus_handle)
                .capture_action(cx.listener(Self::copy_selection))
                .child(SelectionSurface::new(
                    "selection-harness-surface",
                    self.selection.clone(),
                    div()
                        .absolute()
                        .left(px(40.0))
                        .top(px(40.0))
                        .w(px(320.0))
                        .flex()
                        .flex_col()
                        .text_size(px(20.0))
                        .line_height(relative(1.0))
                        .child(SelectableText::new(
                            "selection-harness-first",
                            self.selection.clone(),
                            0,
                            "alpha",
                        ))
                        .child(
                            SelectableText::new(
                                "selection-harness-second",
                                self.selection.clone(),
                                1,
                                "βeta",
                            )
                            .separator_before("\n"),
                        ),
                ))
        }
    }

    #[gpui::test]
    fn drag_selection_across_fragments_reaches_the_clipboard(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let harness = Rc::new(RefCell::new(None));
        let harness_for_window = harness.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let focus_handle = cx.focus_handle();
                let view = cx.new(move |_| SelectionHarness {
                    selection: TextSelection::default(),
                    focus_handle,
                });
                view.focus_handle(cx).focus(window);
                *harness_for_window.borrow_mut() = Some(view.clone());
                view
            })
            .expect("the selection harness should open")
        });
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        cx.run_until_parked();

        cx.simulate_mouse_down(
            point(px(41.0), px(45.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.simulate_mouse_move(
            point(px(350.0), px(75.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.simulate_mouse_up(
            point(px(350.0), px(75.0)),
            MouseButton::Left,
            Modifiers::default(),
        );

        let harness = harness
            .borrow()
            .clone()
            .expect("the selection harness entity should be retained");
        assert_eq!(
            cx.cx
                .update(|cx| harness.read(cx).selection.selected_text()),
            Some("alpha\nβeta".to_owned())
        );

        cx.simulate_mouse_down(
            point(px(350.0), px(75.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.simulate_mouse_move(
            point(px(41.0), px(45.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.simulate_mouse_up(
            point(px(41.0), px(45.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        assert_eq!(
            cx.cx
                .update(|cx| harness.read(cx).selection.selected_text()),
            Some("alpha\nβeta".to_owned())
        );

        cx.dispatch_action(Copy);
        assert_eq!(
            cx.read_from_clipboard().and_then(|item| item.text()),
            Some("alpha\nβeta".to_owned())
        );
    }
}
