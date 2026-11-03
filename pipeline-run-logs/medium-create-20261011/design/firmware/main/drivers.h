#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
/* ASSUMED module configuration; verify physical revision/address before connection. */
#define SHT40_ADDRESS 0x44
#define OLED_ADDRESS 0x3C
uint8_t sht40_crc(const uint8_t *data, unsigned size);
esp_err_t sht40_measure(float *temperature_c, float *humidity_percent);
esp_err_t oled_init(void);
esp_err_t oled_render(bool valid, float temperature_c, float humidity_percent, bool power_fault);
