#include "drivers.h"
#include "board_hal.h"
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

uint8_t sht40_crc(const uint8_t *data, unsigned size)
{
    uint8_t crc = 0xFF;
    for (unsigned i = 0; i < size; ++i) {
        crc ^= data[i];
        for (unsigned bit = 0; bit < 8; ++bit)
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
    }
    return crc;
}

esp_err_t sht40_measure(float *temperature_c, float *humidity_percent)
{
    /* 0xFD requests high precision without heater; no heater command exists here. */
    const uint8_t command = 0xFD;
    esp_err_t err = board_write(SHT40_ADDRESS, &command, 1);
    if (err != ESP_OK) return err;
    vTaskDelay(pdMS_TO_TICKS(10));
    uint8_t data[6];
    err = board_read(SHT40_ADDRESS, data, sizeof(data));
    if (err != ESP_OK) return err;
    if (sht40_crc(data, 2) != data[2] || sht40_crc(data + 3, 2) != data[5])
        return ESP_ERR_INVALID_CRC;
    uint16_t raw_t = ((uint16_t)data[0] << 8) | data[1];
    uint16_t raw_rh = ((uint16_t)data[3] << 8) | data[4];
    *temperature_c = -45.0f + 175.0f * raw_t / 65535.0f;
    float rh = -6.0f + 125.0f * raw_rh / 65535.0f;
    /* Datasheet reporting conversion clips RH to its physical 0..100% range. */
    *humidity_percent = rh < 0 ? 0 : rh > 100 ? 100 : rh;
    return ESP_OK;
}

static esp_err_t commands(const uint8_t *data, size_t size)
{
    uint8_t packet[32];
    if (size > sizeof(packet) - 1) return ESP_ERR_INVALID_SIZE;
    packet[0] = 0x00;
    memcpy(packet + 1, data, size);
    return board_write(OLED_ADDRESS, packet, size + 1);
}

esp_err_t oled_init(void)
{
    board_oled_reset();
    /* ASSUMED SSD1306 128x64 charge-pump module; low contrast limits brightness. */
    const uint8_t init[] = {0xAE,0xD5,0x80,0xA8,0x3F,0xD3,0x00,0x40,
        0x8D,0x14,0x20,0x02,0xA1,0xC8,0xDA,0x12,0x81,0x20,
        0xD9,0xF1,0xDB,0x40,0xA4,0xA6,0xAF};
    return commands(init, sizeof(init));
}

/* Original compact 5x7 glyph data for the measurement/error vocabulary. */
static const uint8_t *glyph(char c)
{
    static const uint8_t digits[10][5] = {
        {0x3E,0x51,0x49,0x45,0x3E},{0,0x42,0x7F,0x40,0},
        {0x42,0x61,0x51,0x49,0x46},{0x21,0x41,0x45,0x4B,0x31},
        {0x18,0x14,0x12,0x7F,0x10},{0x27,0x45,0x45,0x45,0x39},
        {0x3C,0x4A,0x49,0x49,0x30},{1,0x71,9,5,3},
        {0x36,0x49,0x49,0x49,0x36},{6,0x49,0x49,0x29,0x1E}};
    static const char letters[] = "ACEFHILMNOPRSTU";
    static const uint8_t fonts[][5] = {
        {0x7E,0x11,0x11,0x11,0x7E},{0x3E,0x41,0x41,0x41,0x22},
        {0x7F,0x49,0x49,0x49,0x41},{0x7F,9,9,9,1},
        {0x7F,8,8,8,0x7F},{0,0x41,0x7F,0x41,0},
        {0x7F,0x40,0x40,0x40,0x40},{0x7F,2,0x0C,2,0x7F},
        {0x7F,4,8,0x10,0x7F},{0x3E,0x41,0x41,0x41,0x3E},
        {0x7F,9,9,9,6},{0x7F,9,0x19,0x29,0x46},
        {0x46,0x49,0x49,0x49,0x31},{1,1,0x7F,1,1},
        {0x3F,0x40,0x40,0x40,0x3F}};
    static const uint8_t space[5] = {0};
    static const uint8_t dot[5] = {0,0x60,0x60,0,0};
    static const uint8_t minus[5] = {8,8,8,8,8};
    static const uint8_t percent[5] = {0x63,0x13,8,0x64,0x63};
    static const uint8_t colon[5] = {0,0x36,0x36,0,0};
    if (c >= '0' && c <= '9') return digits[c - '0'];
    if (c == '.') return dot;
    if (c == '-') return minus;
    if (c == '%') return percent;
    if (c == ':') return colon;
    const char *found = strchr(letters, c);
    return found && c ? fonts[found - letters] : space;
}

static void text(uint8_t frame[8][128], unsigned page, const char *s)
{
    unsigned x = 0;
    while (*s && x + 5 < 128) {
        memcpy(&frame[page][x], glyph(*s++), 5);
        x += 6;
    }
}

esp_err_t oled_render(bool valid, float temperature_c, float humidity_percent, bool power_fault)
{
    uint8_t frame[8][128] = {0};
    char line[24];
    text(frame, 0, "TEMP RH");
    if (valid) {
        snprintf(line, sizeof(line), "T: %.1f C", temperature_c);
        text(frame, 2, line);
        snprintf(line, sizeof(line), "RH: %.1f %%", humidity_percent);
        text(frame, 4, line);
    } else {
        text(frame, 2, "SENSOR ERROR");
        text(frame, 4, "RETRY 1 S");
    }
    if (power_fault) text(frame, 6, "POWER FAULT");
    for (unsigned page = 0; page < 8; ++page) {
        const uint8_t position[] = {(uint8_t)(0xB0 + page), 0x00, 0x10};
        esp_err_t err = commands(position, sizeof(position));
        if (err != ESP_OK) return err;
        uint8_t packet[129];
        packet[0] = 0x40;
        memcpy(packet + 1, frame[page], 128);
        err = board_write(OLED_ADDRESS, packet, sizeof(packet));
        if (err != ESP_OK) return err;
    }
    return ESP_OK;
}
