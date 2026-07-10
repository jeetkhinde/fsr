import assert from 'node:assert/strict';
import { injectFsrSlots } from './baking.js';

function runTests() {
  console.log('Running FSR baking tests...');

  // 1. replaces_single_slot
  {
    const shell = '<span s-live="ticket_status">Loading</span>';
    const slots: [string, any][] = [['ticket_status', 'Resolved']];
    const result = injectFsrSlots(shell, slots);
    assert.equal(result, '<span s-live="ticket_status">Resolved</span>');
    console.log('✅ replaces_single_slot passed');
  }

  // 2. escapes_html_in_value
  {
    const shell = '<span s-live="title">old</span>';
    const slots: [string, any][] = [['title', '<script>alert(1)</script>']];
    const result = injectFsrSlots(shell, slots);
    assert.ok(result.includes('&lt;script&gt;'));
    assert.ok(!result.includes('<script>'));
    console.log('✅ escapes_html_in_value passed');
  }

  // 3. missing_slot_leaves_content_unchanged
  {
    const shell = '<span s-live="status">Default</span>';
    const slots: [string, any][] = [];
    const result = injectFsrSlots(shell, slots);
    assert.equal(result, shell);
    console.log('✅ missing_slot_leaves_content_unchanged passed');
  }

  // 4. replaces_multiple_slots_in_one_pass
  {
    const shell = '<span s-live="a">x</span><span s-live="b">y</span>';
    const slots: [string, any][] = [
      ['a', 'AAA'],
      ['b', 'BBB'],
    ];
    const result = injectFsrSlots(shell, slots);
    assert.ok(result.includes('>AAA<'));
    assert.ok(result.includes('>BBB<'));
    console.log('✅ replaces_multiple_slots_in_one_pass passed');
  }

  // 5. null_value_clears_slot_content
  {
    const shell = '<span s-live="count">99</span>';
    const slots: [string, any][] = [['count', null]];
    const result = injectFsrSlots(shell, slots);
    assert.equal(result, '<span s-live="count"></span>');
    console.log('✅ null_value_clears_slot_content passed');
  }

  // 6. numeric_json_value_serialised_as_string
  {
    const shell = '<span s-live="price">0</span>';
    const slots: [string, any][] = [['price', 42]];
    const result = injectFsrSlots(shell, slots);
    assert.equal(result, '<span s-live="price">42</span>');
    console.log('✅ numeric_json_value_serialised_as_string passed');
  }

  // 7. unrelated_slot_name_not_matched
  {
    const shell = '<span s-live="status">Open</span>';
    const slots: [string, any][] = [['priority', 'High']];
    const result = injectFsrSlots(shell, slots);
    assert.equal(result, shell);
    console.log('✅ unrelated_slot_name_not_matched passed');
  }

  // 8. patches_generated_data_kiln_live_field_markers
  {
    const shell = '<span data-kiln-live-field="status">in_progress</span>';
    const slots: [string, any][] = [['status', 'complete']];
    const result = injectFsrSlots(shell, slots);
    assert.equal(result, '<span data-kiln-live-field="status">complete</span>');
    console.log('✅ patches_generated_data_kiln_live_field_markers passed');
  }

  console.log('🎉 All FSR baking tests passed!');
}

runTests();
