#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
esp_err_t board_init(void);
esp_err_t board_write(uint8_t address, const uint8_t *data, size_t size);
esp_err_t board_read(uint8_t address, uint8_t *data, size_t size);
void board_oled_reset(void);
bool board_power_fault(void);
