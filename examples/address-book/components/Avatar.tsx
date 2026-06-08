import React from "react";
import { getContactInitials, getContactName } from "../db/presentation.js";
import type { Contact } from "../db/types.js";

type AvatarContact = Pick<
  Contact,
  "id" | "firstName" | "lastName" | "avatarUrl"
>;

export function Avatar({
  contact,
  size = "row",
}: {
  contact: AvatarContact;
  size?: "row" | "hero";
}) {
  const initials = getContactInitials(contact);
  const hue = Number((BigInt(contact.id) * 47n) % 360n);

  return (
    <span
      className={`avatar avatar--${size}`}
      data-avatar
      style={{ "--avatar-hue": hue } as React.CSSProperties}
    >
      <span className="avatar__fallback" aria-hidden="true">
        {initials}
      </span>
      {contact.avatarUrl ? (
        <img
          className="avatar__image"
          src={contact.avatarUrl}
          alt={`${getContactName(contact)} portrait`}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : null}
    </span>
  );
}
