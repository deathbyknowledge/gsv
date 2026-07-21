#include "page_gsv.h"

#include <stdio.h>
#include <string.h>

#include "../conf/ui.h"
#include "core/gsv_ipc.h"
#include "lang/language.h"
#include "ui/page_common.h"
#include "ui/ui_style.h"

#if defined(HDZGOGGLE) || defined(HDZGOGGLE2)
static lv_coord_t col_dsc[] = {180, 180, 180, 180, 180, LV_GRID_TEMPLATE_LAST};
static lv_coord_t row_dsc[] = {55, 42, 82, 42, 112, 55, 55, 55, 55, 55, LV_GRID_TEMPLATE_LAST};
#else
static lv_coord_t col_dsc[] = {130, 130, 130, 130, 130, LV_GRID_TEMPLATE_LAST};
static lv_coord_t row_dsc[] = {40, 30, 55, 30, 70, 40, 40, 40, 40, 40, LV_GRID_TEMPLATE_LAST};
#endif

static lv_obj_t *status_label;
static lv_obj_t *transcript_label;
static lv_obj_t *answer_label;
static lv_obj_t *ptt_label;
static lv_obj_t *speech_label;
static lv_obj_t *overlay;
static lv_obj_t *overlay_label;
static uint64_t rendered_version;

static lv_obj_t *create_wrapped_label(lv_obj_t *parent, int row, int row_span) {
    lv_obj_t *label = lv_label_create(parent);
    lv_label_set_text(label, "—");
    lv_obj_set_style_text_font(label, UI_PAGE_LABEL_FONT, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(TEXT_COLOR_DEFAULT), 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_LEFT, 0);
    lv_label_set_long_mode(label, LV_LABEL_LONG_DOT);
    lv_obj_set_grid_cell(label, LV_GRID_ALIGN_STRETCH, 0, 5,
                         LV_GRID_ALIGN_STRETCH, row, row_span);
    return label;
}

static lv_obj_t *create_action_label(lv_obj_t *parent, const char *text, int row) {
    lv_obj_t *label = lv_label_create(parent);
    lv_label_set_text(label, text);
    lv_obj_set_style_text_font(label, UI_PAGE_TEXT_FONT, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(TEXT_COLOR_DEFAULT), 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_style_pad_top(label, UI_PAGE_TEXT_PAD, 0);
    lv_label_set_long_mode(label, LV_LABEL_LONG_DOT);
    lv_obj_set_grid_cell(label, LV_GRID_ALIGN_STRETCH, 0, 5,
                         LV_GRID_ALIGN_STRETCH, row, 1);
    return label;
}

static void create_overlay(void) {
    overlay = lv_obj_create(lv_scr_act());
    lv_obj_set_size(overlay, LV_PCT(62), LV_SIZE_CONTENT);
    lv_obj_align(overlay, LV_ALIGN_TOP_MID, 0, 54);
    lv_obj_set_style_bg_color(overlay, lv_color_hex(0x101418), 0);
    lv_obj_set_style_bg_opa(overlay, LV_OPA_90, 0);
    lv_obj_set_style_border_width(overlay, 2, 0);
    lv_obj_set_style_border_color(overlay, lv_color_hex(0x3be3a2), 0);
    lv_obj_set_style_pad_all(overlay, 12, 0);
    lv_obj_clear_flag(overlay, LV_OBJ_FLAG_SCROLLABLE);

    overlay_label = lv_label_create(overlay);
    lv_obj_set_width(overlay_label, LV_PCT(100));
    lv_obj_set_style_text_font(overlay_label, UI_PAGE_LABEL_FONT, 0);
    lv_obj_set_style_text_color(overlay_label, lv_color_white(), 0);
    lv_obj_set_style_text_align(overlay_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(overlay_label, LV_LABEL_LONG_WRAP);
    lv_label_set_text(overlay_label, "");
    lv_obj_add_flag(overlay, LV_OBJ_FLAG_HIDDEN);
}

static lv_obj_t *page_gsv_create(lv_obj_t *parent, panel_arr_t *arr) {
    lv_obj_t *page = lv_menu_page_create(parent, NULL);
    lv_obj_clear_flag(page, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_size(page, UI_PAGE_VIEW_SIZE);
    lv_obj_add_style(page, &style_subpage, LV_PART_MAIN);

    lv_obj_t *section = lv_menu_section_create(page);
    lv_obj_add_style(section, &style_submenu, LV_PART_MAIN);
    lv_obj_set_size(section, UI_PAGE_VIEW_SIZE);
    create_text(NULL, section, false, "GSV Voice:", LV_MENU_ITEM_BUILDER_VARIANT_2);

    lv_obj_t *content = lv_obj_create(section);
    lv_obj_set_size(content, UI_PAGE_VIEW_SIZE);
    lv_obj_set_layout(content, LV_LAYOUT_GRID);
    lv_obj_clear_flag(content, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_style(content, &style_context, LV_PART_MAIN);
    lv_obj_set_style_grid_column_dsc_array(content, col_dsc, 0);
    lv_obj_set_style_grid_row_dsc_array(content, row_dsc, 0);

    create_select_item(arr, content);
    for (int i = 0; i < 4; ++i) {
        lv_obj_set_grid_cell(arr->panel[i], LV_GRID_ALIGN_STRETCH, 0, 5,
                             LV_GRID_ALIGN_STRETCH, 6 + i, 1);
    }

    status_label = create_wrapped_label(content, 0, 1);
    lv_obj_set_style_text_font(status_label, UI_PAGE_TEXT_FONT, 0);
    lv_obj_set_style_text_color(status_label, lv_color_hex(0x3be3a2), 0);

    lv_obj_t *transcript_title = create_label_item(content, "YOU", 0, 1, 1);
    lv_obj_set_style_text_color(transcript_title, lv_color_hex(0x8fa4b8), 0);
    transcript_label = create_wrapped_label(content, 2, 1);

    lv_obj_t *answer_title = create_label_item(content, "AGENT", 0, 3, 1);
    lv_obj_set_style_text_color(answer_title, lv_color_hex(0x3be3a2), 0);
    answer_label = create_wrapped_label(content, 4, 1);

    ptt_label = create_action_label(content, "Start recording", 6);
    speech_label = create_action_label(content, "Speak replies: Off", 7);
    create_action_label(content, "Cancel active request", 8);
    create_action_label(content, "< Back", 9);

    create_overlay();
    return page;
}

static void page_gsv_created(void) {
    gsv_ipc_init();
}

static void page_gsv_click(uint8_t key, int selected) {
    (void)key;
    if (selected == 0) {
        gsv_ipc_send_command("ptt.toggle");
    } else if (selected == 1) {
        gsv_ipc_send_command("speech.toggle");
    } else if (selected == 2) {
        gsv_ipc_send_command("cancel");
    }
}

static void page_gsv_right_button(bool is_short) {
    if (is_short) {
        gsv_ipc_send_command("ptt.toggle");
    }
}

static void update_overlay(const gsv_snapshot_t *snapshot) {
    if (strcmp(snapshot->phase, "idle") == 0 || strcmp(snapshot->connection, "online") != 0) {
        lv_obj_add_flag(overlay, LV_OBJ_FLAG_HIDDEN);
        return;
    }

    char text[640];
    if (snapshot->error[0]) {
        snprintf(text, sizeof(text), "GSV · ERROR\n%.500s", snapshot->error);
        lv_obj_set_style_border_color(overlay, lv_color_hex(0xff5f57), 0);
    } else if (snapshot->answer[0] &&
               (strcmp(snapshot->phase, "answering") == 0 ||
                strcmp(snapshot->phase, "answer") == 0 ||
                strcmp(snapshot->phase, "speaking") == 0)) {
        snprintf(text, sizeof(text), "GSV · %s\n%.500s", snapshot->status, snapshot->answer);
        lv_obj_set_style_border_color(overlay, lv_color_hex(0x3be3a2), 0);
    } else {
        snprintf(text, sizeof(text), "GSV · %s", snapshot->status);
        lv_obj_set_style_border_color(overlay, lv_color_hex(0x3be3a2), 0);
    }
    lv_label_set_text(overlay_label, text);
    lv_obj_clear_flag(overlay, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(overlay);
}

static void page_gsv_update(uint32_t delta_ms) {
    (void)delta_ms;
    gsv_snapshot_t snapshot;
    gsv_ipc_copy_snapshot(&snapshot);
    if (snapshot.version == rendered_version) {
        return;
    }
    rendered_version = snapshot.version;

    char status[256];
    snprintf(status, sizeof(status), "%s · %s",
             strcmp(snapshot.connection, "online") == 0 ? "ONLINE" : "OFFLINE",
             snapshot.error[0] ? snapshot.error : snapshot.status);
    lv_label_set_text(status_label, status);
    lv_obj_set_style_text_color(status_label,
                                strcmp(snapshot.connection, "online") == 0
                                    ? lv_color_hex(0x3be3a2)
                                    : lv_color_hex(0xffb454),
                                0);
    lv_label_set_text(transcript_label, snapshot.transcript[0] ? snapshot.transcript : "—");
    lv_label_set_text(answer_label, snapshot.answer[0] ? snapshot.answer : "—");
    lv_label_set_text(ptt_label,
                      strcmp(snapshot.phase, "recording") == 0
                          ? "Stop and send recording"
                          : "Start recording");
    lv_label_set_text(speech_label, snapshot.speak ? "Speak replies: On" : "Speak replies: Off");
    update_overlay(&snapshot);
}

page_pack_t pp_gsv = {
    .p_arr = {
        .cur = 0,
        .max = 4,
    },
    .name = "GSV Voice",
    .create = page_gsv_create,
    .enter = NULL,
    .exit = NULL,
    .on_created = page_gsv_created,
    .on_update = page_gsv_update,
    .on_roller = NULL,
    .on_click = page_gsv_click,
    .on_right_button = page_gsv_right_button,
};
