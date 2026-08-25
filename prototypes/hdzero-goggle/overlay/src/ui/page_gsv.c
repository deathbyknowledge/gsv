#include "page_gsv.h"

#include <stdio.h>
#include <string.h>

#include "../conf/ui.h"
#include "core/gsv_ipc.h"
#include "lang/language.h"
#include "ui/page_common.h"
#include "ui/ui_style.h"

#define COLOR_ACCENT  0x3be3a2
#define COLOR_MUTED   0x8fa4b8
#define COLOR_WARNING 0xffb454
#define COLOR_ERROR   0xff5f57
#define COLOR_CARD    0x101820

#if defined(HDZGOGGLE) || defined(HDZGOGGLE2)
static lv_coord_t col_dsc[] = {180, 180, 180, 180, 180, LV_GRID_TEMPLATE_LAST};
static lv_coord_t row_dsc[] = {46, 38, 34, 160, 34, 130, 46, 46, 46, 46, 46,
                               LV_GRID_TEMPLATE_LAST};
#else
static lv_coord_t col_dsc[] = {130, 130, 130, 130, 130, LV_GRID_TEMPLATE_LAST};
static lv_coord_t row_dsc[] = {34, 28, 26, 110, 26, 90, 34, 34, 34, 34, 34,
                               LV_GRID_TEMPLATE_LAST};
#endif

static lv_obj_t *connection_label;
static lv_obj_t *tabs_label;
static lv_obj_t *primary_title;
static lv_obj_t *primary_label;
static lv_obj_t *secondary_title;
static lv_obj_t *secondary_label;
static lv_obj_t *primary_card;
static lv_obj_t *secondary_card;
static lv_obj_t *presentation_image;
static lv_obj_t *voice_label;
static lv_obj_t *speech_label;
static lv_obj_t *overlay;
static lv_obj_t *overlay_label;
static uint64_t rendered_version;
static char presentation_source[GSV_PRESENTATION_PATH_MAX + 4];

static lv_obj_t *create_grid_label(lv_obj_t *parent, int row, int row_span,
                                   const lv_font_t *font, uint32_t color) {
    lv_obj_t *label = lv_label_create(parent);
    lv_label_set_text(label, "—");
    lv_obj_set_style_text_font(label, font, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(color), 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_style_pad_left(label, 14, 0);
    lv_obj_set_style_pad_right(label, 14, 0);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_grid_cell(label, LV_GRID_ALIGN_STRETCH, 0, 5,
                         LV_GRID_ALIGN_STRETCH, row, row_span);
    return label;
}

static lv_obj_t *create_card(lv_obj_t *parent, int row, int row_span, uint32_t border_color) {
    lv_obj_t *card = lv_obj_create(parent);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(card, lv_color_hex(COLOR_CARD), 0);
    lv_obj_set_style_bg_opa(card, LV_OPA_90, 0);
    lv_obj_set_style_border_width(card, 1, 0);
    lv_obj_set_style_border_color(card, lv_color_hex(border_color), 0);
    lv_obj_set_style_radius(card, 8, 0);
    lv_obj_set_grid_cell(card, LV_GRID_ALIGN_STRETCH, 0, 5,
                         LV_GRID_ALIGN_STRETCH, row, row_span);
    return card;
}

static lv_obj_t *create_action_label(lv_obj_t *parent, const char *text, int row) {
    lv_obj_t *label = lv_label_create(parent);
    lv_label_set_text(label, text);
    lv_obj_set_style_text_font(label, UI_PAGE_TEXT_FONT, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(TEXT_COLOR_DEFAULT), 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_style_pad_top(label, UI_PAGE_TEXT_PAD, 0);
    lv_obj_set_style_pad_left(label, 14, 0);
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
    lv_obj_set_style_border_color(overlay, lv_color_hex(COLOR_ACCENT), 0);
    lv_obj_set_style_pad_all(overlay, 12, 0);
    lv_obj_set_style_radius(overlay, 8, 0);
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
    create_text(NULL, section, false, "GSV Wearable", LV_MENU_ITEM_BUILDER_VARIANT_2);

    lv_obj_t *content = lv_obj_create(section);
    lv_obj_set_size(content, UI_PAGE_VIEW_SIZE);
    lv_obj_set_layout(content, LV_LAYOUT_GRID);
    lv_obj_clear_flag(content, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_style(content, &style_context, LV_PART_MAIN);
    lv_obj_set_style_grid_column_dsc_array(content, col_dsc, 0);
    lv_obj_set_style_grid_row_dsc_array(content, row_dsc, 0);

    primary_card = create_card(content, 2, 2, COLOR_MUTED);
    secondary_card = create_card(content, 4, 2, COLOR_ACCENT);
    create_select_item(arr, content);
    for (int i = 0; i < 5; ++i) {
        lv_obj_set_grid_cell(arr->panel[i], LV_GRID_ALIGN_STRETCH, 0, 5,
                             LV_GRID_ALIGN_STRETCH, 6 + i, 1);
    }

    connection_label = create_grid_label(content, 0, 1, UI_PAGE_TEXT_FONT, COLOR_ACCENT);
    tabs_label = create_grid_label(content, 1, 1, UI_PAGE_LABEL_FONT, COLOR_MUTED);
    lv_obj_set_style_text_align(tabs_label, LV_TEXT_ALIGN_CENTER, 0);

    primary_title = create_grid_label(content, 2, 1, UI_PAGE_LABEL_FONT, COLOR_MUTED);
    primary_label = create_grid_label(content, 3, 1, UI_PAGE_LABEL_FONT, TEXT_COLOR_DEFAULT);
    secondary_title = create_grid_label(content, 4, 1, UI_PAGE_LABEL_FONT, COLOR_ACCENT);
    secondary_label = create_grid_label(content, 5, 1, UI_PAGE_LABEL_FONT, TEXT_COLOR_DEFAULT);

    presentation_image = lv_img_create(content);
    lv_obj_set_grid_cell(presentation_image, LV_GRID_ALIGN_CENTER, 0, 5,
                         LV_GRID_ALIGN_CENTER, 2, 4);
    lv_obj_add_flag(presentation_image, LV_OBJ_FLAG_HIDDEN);

    voice_label = create_action_label(content, "Talk to GSV", 6);
    create_action_label(content, "Next workspace", 7);
    speech_label = create_action_label(content, "Speak replies: Off", 8);
    create_action_label(content, "Cancel active request", 9);
    create_action_label(content, "< Back", 10);

    create_overlay();
    return page;
}

static void page_gsv_created(void) {
    gsv_ipc_init();
}

static void page_gsv_click(uint8_t key, int selected) {
    (void)key;
    if (selected == 0) {
        gsv_ipc_send_action("voice.toggle");
    } else if (selected == 1) {
        gsv_ipc_send_action("view.next");
    } else if (selected == 2) {
        gsv_ipc_send_action("speech.toggle");
    } else if (selected == 3) {
        gsv_ipc_send_action("request.cancel");
    }
}

static void page_gsv_right_button(bool is_short) {
    gsv_ipc_send_action(is_short ? "voice.toggle" : "view.next");
}

static void update_overlay(const gsv_snapshot_t *snapshot) {
    if (strcmp(snapshot->phase, "idle") == 0 ||
        strcmp(snapshot->client_connection, "online") != 0) {
        lv_obj_add_flag(overlay, LV_OBJ_FLAG_HIDDEN);
        return;
    }

    char text[640];
    if (snapshot->error[0]) {
        snprintf(text, sizeof(text), "GSV · ERROR\n%.500s", snapshot->error);
        lv_obj_set_style_border_color(overlay, lv_color_hex(COLOR_ERROR), 0);
    } else if (snapshot->answer[0] &&
               (strcmp(snapshot->phase, "answering") == 0 ||
                strcmp(snapshot->phase, "answer") == 0 ||
                strcmp(snapshot->phase, "speaking") == 0)) {
        snprintf(text, sizeof(text), "GSV · %s\n%.500s", snapshot->status, snapshot->answer);
        lv_obj_set_style_border_color(overlay, lv_color_hex(COLOR_ACCENT), 0);
    } else {
        snprintf(text, sizeof(text), "GSV · %s", snapshot->status);
        lv_obj_set_style_border_color(overlay, lv_color_hex(COLOR_ACCENT), 0);
    }
    lv_label_set_text(overlay_label, text);
    lv_obj_clear_flag(overlay, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(overlay);
}

static void show_cards(bool visible) {
    lv_obj_t *objects[] = {
        primary_card,
        secondary_card,
        primary_title,
        primary_label,
        secondary_title,
        secondary_label,
    };
    for (size_t i = 0; i < sizeof(objects) / sizeof(objects[0]); ++i) {
        if (visible) {
            lv_obj_clear_flag(objects[i], LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(objects[i], LV_OBJ_FLAG_HIDDEN);
        }
    }
    if (visible) {
        lv_obj_add_flag(presentation_image, LV_OBJ_FLAG_HIDDEN);
    }
}

static void update_workspace(const gsv_snapshot_t *snapshot) {
    if (strcmp(snapshot->view, "presentation") == 0) {
        lv_label_set_text(tabs_label, "CONVERSATION   ACTIVITY   DEVICE   [ SHOW ]");
        if (strcmp(snapshot->presentation_kind, "image") == 0 &&
            snapshot->presentation_path[0]) {
            show_cards(false);
            snprintf(presentation_source, sizeof(presentation_source), "A:%.795s",
                     snapshot->presentation_path);
            lv_img_set_src(presentation_image, presentation_source);
            lv_img_set_zoom(presentation_image, 160);
            lv_obj_clear_flag(presentation_image, LV_OBJ_FLAG_HIDDEN);
            return;
        }
        show_cards(true);
        lv_label_set_text(primary_title, "PRESENTED BY AGENT");
        lv_label_set_text(primary_label,
                          snapshot->presentation_title[0]
                              ? snapshot->presentation_title
                              : "GSV");
        lv_label_set_text(secondary_title, "CONTENT");
        lv_label_set_text(secondary_label,
                          snapshot->presentation_body[0]
                              ? snapshot->presentation_body
                              : "No active presentation");
        return;
    }

    show_cards(true);
    if (strcmp(snapshot->view, "activity") == 0) {
        lv_label_set_text(tabs_label, "CONVERSATION   [ ACTIVITY ]   DEVICE   SHOW");
        lv_label_set_text(primary_title, "CURRENT SESSION");
        char current[320];
        snprintf(current, sizeof(current), "%s\nPhase: %s", snapshot->status, snapshot->phase);
        lv_label_set_text(primary_label, current);
        lv_label_set_text(secondary_title, "RECENT DEVICE ACTIVITY");
        lv_label_set_text(secondary_label,
                          snapshot->activity[0] ? snapshot->activity : "No device activity yet");
        return;
    }

    if (strcmp(snapshot->view, "device") == 0) {
        lv_label_set_text(tabs_label, "CONVERSATION   ACTIVITY   [ DEVICE ]   SHOW");
        lv_label_set_text(primary_title, "WEARABLE CLIENT");
        char client[320];
        snprintf(client, sizeof(client), "%s\n%s",
                 strcmp(snapshot->client_connection, "online") == 0 ? "ONLINE" : "OFFLINE",
                 snapshot->status);
        lv_label_set_text(primary_label, client);
        lv_label_set_text(secondary_title, "MACHINE TARGET");
        char device[420];
        snprintf(device, sizeof(device), "%s · %.80s\nFull FS · pseudo-shell · gsv-show",
                 strcmp(snapshot->driver_connection, "online") == 0 ? "ONLINE" : "OFFLINE",
                 snapshot->device_id[0] ? snapshot->device_id : "not configured");
        lv_label_set_text(secondary_label, device);
        return;
    }

    lv_label_set_text(tabs_label, "[ CONVERSATION ]   ACTIVITY   DEVICE   SHOW");
    lv_label_set_text(primary_title, "YOU");
    lv_label_set_text(primary_label, snapshot->transcript[0] ? snapshot->transcript : "Press Talk to begin");
    lv_label_set_text(secondary_title, "AGENT");
    lv_label_set_text(secondary_label, snapshot->answer[0] ? snapshot->answer : "Ready when you are");
}

static void page_gsv_update(uint32_t delta_ms) {
    (void)delta_ms;
    gsv_snapshot_t snapshot;
    gsv_ipc_copy_snapshot(&snapshot);
    if (snapshot.version == rendered_version) {
        return;
    }
    rendered_version = snapshot.version;

    char connections[192];
    snprintf(connections, sizeof(connections), "CLIENT %s       TARGET %s",
             strcmp(snapshot.client_connection, "online") == 0 ? "ONLINE" : "OFFLINE",
             strcmp(snapshot.driver_connection, "online") == 0 ? "ONLINE" : "OFFLINE");
    lv_label_set_text(connection_label, connections);
    lv_obj_set_style_text_color(connection_label,
                                strcmp(snapshot.client_connection, "online") == 0 &&
                                        strcmp(snapshot.driver_connection, "online") == 0
                                    ? lv_color_hex(COLOR_ACCENT)
                                    : lv_color_hex(COLOR_WARNING),
                                0);

    update_workspace(&snapshot);
    lv_label_set_text(voice_label,
                      strcmp(snapshot.phase, "recording") == 0
                          ? "Stop and send recording"
                          : "Talk to GSV");
    lv_label_set_text(speech_label, snapshot.speak ? "Speak replies: On" : "Speak replies: Off");
    update_overlay(&snapshot);
}

page_pack_t pp_gsv = {
    .p_arr = {
        .cur = 0,
        .max = 5,
    },
    .name = "GSV Wearable",
    .create = page_gsv_create,
    .enter = NULL,
    .exit = NULL,
    .on_created = page_gsv_created,
    .on_update = page_gsv_update,
    .on_roller = NULL,
    .on_click = page_gsv_click,
    .on_right_button = page_gsv_right_button,
};
