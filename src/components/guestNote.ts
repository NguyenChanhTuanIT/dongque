// Banner for players without an account (rewards and shop panels): their
// flowers and items live in a guest wallet that only lasts as long as the tab
// (server/wallets.mjs "Guests"). Signing up moves it into the new account.
// Without a Firebase config there are no accounts: the banner then only warns.

import { isLoginAvailable } from '../social/auth';

export function guestWarning(): string {
  if (!isLoginAvailable()) {
    return (
      '<div class="look-group guest-note" role="note">' +
      '<p><b>Bạn đang chơi ẩn danh.</b> Hoa và đồ chỉ lưu trong tab này, sẽ <b>mất khi đóng tab</b>.</p>' +
      '</div>'
    );
  }
  return (
    '<div class="look-group guest-note" role="note">' +
    '<p><b>Bạn đang chơi ẩn danh.</b> Hoa và đồ chỉ lưu trong tab này, sẽ <b>mất khi đóng tab</b>. Đăng ký để đồng bộ vào tài khoản.</p>' +
    '<button type="button" class="primary" data-register>Đăng ký</button>' +
    '<button type="button" data-login>Đã có tài khoản</button>' +
    '</div>'
  );
}
