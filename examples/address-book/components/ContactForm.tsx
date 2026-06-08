import React from "react";
import type { ContactFieldErrors, ContactFormValues } from "../db/types.js";

const emptyValues: ContactFormValues = {
  firstName: "",
  lastName: "",
  company: "",
  role: "",
  email: "",
  phone: "",
  location: "",
  handle: "",
  website: "",
  avatarUrl: "",
  notes: "",
};

export function ContactForm({
  action,
  values = emptyValues,
  errors = {},
  submitLabel,
}: {
  action: string;
  values?: ContactFormValues;
  errors?: ContactFieldErrors;
  submitLabel: string;
}) {
  const field = (
    name: keyof ContactFormValues,
    label: string,
    type = "text",
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={values[name]}
        aria-invalid={Boolean(errors[name])}
        aria-describedby={errors[name] ? `${name}-error` : undefined}
      />
      {errors[name] ? (
        <small id={`${name}-error`} className="field__error">
          {errors[name]}
        </small>
      ) : null}
    </label>
  );

  return (
    <form
      className="contact-form"
      method="post"
      action={action}
      data-contact-form
    >
      <div className="contact-form__heading">
        <a
          href="/contacts"
          s-html=""
          data-preserve-query
          className="mobile-back"
        >
          ‹ People
        </a>
        <h1>{submitLabel}</h1>
      </div>
      {errors.name ? <p className="form-error">{errors.name}</p> : null}
      <div className="form-grid">
        {field("firstName", "First name")}
        {field("lastName", "Last name")}
        {field("company", "Company")}
        {field("role", "Role")}
        {field("email", "Email", "email")}
        {field("phone", "Phone", "tel")}
        {field("location", "Location")}
        {field("handle", "Handle")}
        {field("website", "Website", "url")}
        {field("avatarUrl", "Portrait URL", "url")}
        <label className="field field--wide">
          <span>Notes</span>
          <textarea
            name="notes"
            defaultValue={values.notes}
            maxLength={2000}
            rows={6}
          />
          {errors.notes ? (
            <small className="field__error">{errors.notes}</small>
          ) : null}
        </label>
      </div>
      <p className="form-error" hidden data-form-message />
      <div className="form-actions">
        <a className="button" href="/contacts" s-html="" data-preserve-query>
          Cancel
        </a>
        <button
          className="button button--primary"
          type="submit"
          data-submit-label={submitLabel}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
