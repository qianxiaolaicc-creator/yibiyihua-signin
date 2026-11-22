ALTER TABLE students ADD COLUMN parent_code TEXT;
UPDATE students SET parent_code = upper(hex(randomblob(8))) WHERE parent_code IS NULL;
CREATE UNIQUE INDEX students_parent_code ON students(parent_code);
CREATE INDEX request_limits_expiry ON request_limits(expires_at);

CREATE TABLE restore_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);

DROP TRIGGER lesson_guard;
DROP TRIGGER lesson_deduct;

CREATE TRIGGER lesson_guard BEFORE INSERT ON lessons
WHEN NOT EXISTS (SELECT 1 FROM restore_guard)
BEGIN
  SELECT CASE WHEN NEW.active != 1 THEN RAISE(ABORT, 'INVALID_LESSON_STATE') END;
  SELECT CASE WHEN (SELECT balance FROM students WHERE id=NEW.student_id) < 1 THEN RAISE(ABORT, 'INSUFFICIENT_BALANCE') END;
END;

CREATE TRIGGER lesson_deduct AFTER INSERT ON lessons
WHEN NOT EXISTS (SELECT 1 FROM restore_guard)
BEGIN
  UPDATE students SET balance=balance-1 WHERE id=NEW.student_id;
  INSERT INTO audit_log(id,student_id,action,description,created_at)
  VALUES('lesson:'||NEW.id,NEW.student_id,'lesson','记录 '||NEW.lesson_date||' 上课，扣除 1 课时，剩余 '||(SELECT balance FROM students WHERE id=NEW.student_id),NEW.created_at);
END;
